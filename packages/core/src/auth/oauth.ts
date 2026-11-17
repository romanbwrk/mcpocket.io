import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto"

import { UnauthorizedError } from "../domain/errors"

/**
 * OAuth access tokens for MCP clients that cannot send an API key (ChatGPT
 * connectors and other OAuth-only clients).
 *
 * The authorization server (e.g. Supabase Auth's OAuth 2.1 server, used by
 * MCPocket Cloud, or any OIDC provider) issues signed JWTs; this module
 * verifies them against its JWKS. Authorization comes from a grant claim the
 * server adds to the token (Supabase: a custom access token hook):
 *
 *   "mcpocket": { "ws": "<workspace slug>", "role": "readonly" | "agent" | "operator" }
 *
 * A token without that claim (e.g. a normal sign-in session of the same
 * provider) is rejected, and so is a grant for another workspace: one
 * connection = one workspace. `admin` is never grantable over OAuth.
 *
 * Env (OAuth is off unless MCPOCKET_OAUTH_ISSUER is set):
 *   MCPOCKET_OAUTH_ISSUER     exact `iss`, e.g. https://<ref>.supabase.co/auth/v1
 *   MCPOCKET_OAUTH_JWKS_URL   default <issuer>/.well-known/jwks.json
 *   MCPOCKET_OAUTH_AUDIENCE   required `aud` value (unset = not checked)
 *   MCPOCKET_OAUTH_WORKSPACE  slug the grant must name (default MCPOCKET_SSO_WORKSPACE)
 *   MCPOCKET_OAUTH_CLAIM      grant claim name (default "mcpocket")
 */
export type OAuthConfig = {
  issuer: string
  jwksUrl: string
  audience: string | null
  /** `null` = accept a grant for any workspace (single-workspace self-hosting). */
  workspace: string | null
  claim: string
}

export const OAUTH_GRANTABLE_ROLES = ["readonly", "agent", "operator"] as const
export type OAuthGrantRole = (typeof OAUTH_GRANTABLE_ROLES)[number]

type Env = Record<string, string | undefined>

export function oauthConfigFromEnv(env: Env = process.env): OAuthConfig | null {
  const issuer = env.MCPOCKET_OAUTH_ISSUER?.trim()
  if (!issuer) return null
  if (!/^https?:\/\/[^/]/i.test(issuer)) {
    throw new Error(
      `Invalid MCPOCKET_OAUTH_ISSUER "${issuer}" (absolute http(s) URL)`
    )
  }
  const jwksUrl =
    env.MCPOCKET_OAUTH_JWKS_URL?.trim() ||
    `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`
  return {
    issuer,
    jwksUrl,
    audience: env.MCPOCKET_OAUTH_AUDIENCE?.trim() || null,
    workspace:
      env.MCPOCKET_OAUTH_WORKSPACE?.trim() ||
      env.MCPOCKET_SSO_WORKSPACE?.trim() ||
      null,
    claim: env.MCPOCKET_OAUTH_CLAIM?.trim() || "mcpocket",
  }
}

/** Compact JWS shape (API keys never look like this). */
export const looksLikeJwt = (value: string) =>
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)

export type OAuthIdentity = {
  /** Subject (user id at the authorization server). */
  sub: string
  email: string | null
  clientId: string | null
  role: OAuthGrantRole
  workspace: string
}

/* JWKS --------------------------------------------------------------------- */

type Jwk = JsonWebKey & {
  kid?: string
  kty?: string
  alg?: string
  use?: string
}
export type JwksFetcher = (url: string) => Promise<{ keys: Jwk[] }>

const JWKS_TTL_MS = 10 * 60 * 1000
/** Unknown `kid`: refetch (key rotation), at most this often. */
const JWKS_REFRESH_MIN_MS = 30 * 1000

type CacheEntry = { keys: Map<string, KeyObject>; fetchedAt: number }
const GLOBAL_KEY = Symbol.for("mcpocket.oauthJwks")
type Slot = { [GLOBAL_KEY]?: Map<string, CacheEntry> }
const cache = () => ((globalThis as Slot)[GLOBAL_KEY] ??= new Map())

/** Tests: forget cached keys. */
export function resetOAuthJwksCache() {
  delete (globalThis as Slot)[GLOBAL_KEY]
}

const defaultFetcher: JwksFetcher = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } })
  if (!res.ok) throw new Error(`JWKS ${url}: HTTP ${res.status}`)
  return (await res.json()) as { keys: Jwk[] }
}

async function loadKeys(
  url: string,
  fetcher: JwksFetcher,
  nowMs: number
): Promise<CacheEntry> {
  const { keys } = await fetcher(url)
  const map = new Map<string, KeyObject>()
  for (const [i, jwk] of (keys ?? []).entries()) {
    if (jwk.use && jwk.use !== "sig") continue
    try {
      map.set(jwk.kid ?? `#${i}`, createPublicKey({ key: jwk, format: "jwk" }))
    } catch {
      // Skip keys this runtime cannot import.
    }
  }
  const entry = { keys: map, fetchedAt: nowMs }
  cache().set(url, entry)
  return entry
}

async function keyFor(
  url: string,
  kid: string | undefined,
  fetcher: JwksFetcher,
  nowMs: number
): Promise<KeyObject | null> {
  let entry = cache().get(url)
  if (!entry || nowMs - entry.fetchedAt > JWKS_TTL_MS) {
    entry = await loadKeys(url, fetcher, nowMs)
  }
  const pick = (e: CacheEntry) =>
    kid
      ? (e.keys.get(kid) ?? null)
      : e.keys.size === 1
        ? [...e.keys.values()][0]
        : null
  const found = pick(entry)
  if (found || nowMs - entry.fetchedAt < JWKS_REFRESH_MIN_MS) return found
  return pick(await loadKeys(url, fetcher, nowMs))
}

/* Verification ------------------------------------------------------------- */

const ALGS: Record<string, { hash: string | null; p1363?: true }> = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  ES256: { hash: "sha256", p1363: true },
  ES384: { hash: "sha384", p1363: true },
  EdDSA: { hash: null },
}

const invalid = (why: string) =>
  new UnauthorizedError(`Invalid or expired access token (${why})`)

function decodePart<T>(part: string): T {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T
  } catch {
    throw invalid("malformed")
  }
}

const LEEWAY_S = 30

/**
 * Verifies an OAuth access token and returns the identity and the grant
 * for this workspace. Throws `UnauthorizedError` (→ 401) otherwise.
 */
export async function verifyOAuthToken(
  token: string,
  config: OAuthConfig,
  {
    fetcher = defaultFetcher,
    now = new Date(),
  }: { fetcher?: JwksFetcher; now?: Date } = {}
): Promise<OAuthIdentity> {
  const parts = token.split(".")
  if (parts.length !== 3) throw invalid("malformed")
  const header = decodePart<{ alg?: string; kid?: string }>(parts[0])
  const alg = header.alg ? ALGS[header.alg] : undefined
  if (!alg) throw invalid("unsupported algorithm")

  let key: KeyObject | null
  try {
    key = await keyFor(config.jwksUrl, header.kid, fetcher, now.getTime())
  } catch {
    throw invalid("signing keys unavailable")
  }
  if (!key) throw invalid("unknown signing key")
  const ok = verifySignature(
    alg.hash,
    Buffer.from(`${parts[0]}.${parts[1]}`),
    alg.p1363 ? { key, dsaEncoding: "ieee-p1363" } : key,
    Buffer.from(parts[2], "base64url")
  )
  if (!ok) throw invalid("bad signature")

  const c = decodePart<Record<string, unknown>>(parts[1])
  const nowS = Math.floor(now.getTime() / 1000)
  if (c.iss !== config.issuer) throw invalid("issuer")
  if (typeof c.exp !== "number" || c.exp + LEEWAY_S < nowS)
    throw invalid("expired")
  if (typeof c.nbf === "number" && c.nbf - LEEWAY_S > nowS)
    throw invalid("not yet valid")
  if (config.audience) {
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud]
    if (!aud.includes(config.audience)) throw invalid("audience")
  }
  if (typeof c.sub !== "string" || !c.sub) throw invalid("subject")

  const grant = c[config.claim] as { ws?: unknown; role?: unknown } | undefined
  if (!grant || typeof grant !== "object") throw invalid("no MCPocket grant")
  if (typeof grant.ws !== "string" || !grant.ws)
    throw invalid("no workspace in grant")
  if (config.workspace && grant.ws !== config.workspace) {
    throw invalid("granted for another workspace")
  }
  if (!OAUTH_GRANTABLE_ROLES.includes(grant.role as OAuthGrantRole)) {
    throw invalid("role")
  }
  return {
    sub: c.sub,
    email:
      typeof c.email === "string" && c.email ? c.email.toLowerCase() : null,
    clientId: typeof c.client_id === "string" ? c.client_id : null,
    role: grant.role as OAuthGrantRole,
    workspace: grant.ws,
  }
}

/* Discovery (RFC 9728) ------------------------------------------------------ */

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource"

/**
 * `WWW-Authenticate` for a 401 on an MCP endpoint: points OAuth clients to
 * this resource's metadata (path form, RFC 9728 §3.1).
 */
export function oauthChallenge(
  origin: string,
  resourcePath: string,
  tokenPresented: boolean
): string {
  const metadata = `${origin}${PROTECTED_RESOURCE_PATH}${resourcePath}`
  return tokenPresented
    ? `Bearer resource_metadata="${metadata}", error="invalid_token"`
    : `Bearer resource_metadata="${metadata}"`
}

/** Protected resource metadata for `resource` (an MCP endpoint URL). */
export function protectedResourceMetadata(
  resource: string,
  config: OAuthConfig
) {
  return {
    resource,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
    resource_name: "MCPocket",
  }
}

import {
  apiKeysFromEnv,
  hashSecret,
  sameHash,
  type EnvApiKey,
} from "../auth/api-keys"
import {
  looksLikeJwt,
  oauthConfigFromEnv,
  verifyOAuthToken,
} from "../auth/oauth"
import type { Access } from "../domain/access"
import type { Actor } from "../domain/actor"
import {
  ForbiddenError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
  type RateLimitInfo,
} from "../domain/errors"
import type { ApiKeyRecord } from "../domain/schemas"
import { getStorage } from "../storage"
import { actorWorkspace, multiWorkspaceEnabled } from "../workspace"

import { getRateLimiter, rateLimitPerMinuteFromEnv } from "./rate-limit"

export { apiKeysFromEnv, parseApiKeys } from "../auth/api-keys"
export type { EnvApiKey as ApiKey } from "../auth/api-keys"

/**
 * API-key authentication + per-key rate limiting (plan §10), shared by REST
 * (`apiHandler`) and every MCP HTTP transport.
 *
 * Keys: `MCPOCKET_API_KEYS` (env, read-only, role via
 * `MCPOCKET_API_KEY_ROLES`, default admin) and managed keys (dashboard /
 * REST, stored hashed with role, scope, agent binding, rate limit). Clients
 * send the secret as `Authorization: Bearer <secret>`, `X-API-Key` or, for
 * clients that only take a URL, the `?api_key=<secret>` query parameter. An
 * optional `X-Agent-Id` makes the request an agent acting through the key;
 * a key bound to an agent always acts as that agent.
 */

/** Authenticated caller: the actor (with role/scope) and its key. */
export type Principal = {
  actor: Actor
  keyId: string
  /** Per-key override (managed keys), `null` = server default. */
  rateLimitPerMinute: number | null
}

export type AuthOptions = {
  envKeys?: EnvApiKey[]
  /** Managed keys source; default: the storage singleton. */
  managedKeys?: () => Promise<ApiKeyRecord[]>
}

/** Query parameter accepted instead of an auth header (`?api_key=<secret>`). */
export const API_KEY_QUERY_PARAM = "api_key"
/** Query parameter accepted instead of `X-Agent-Id` (`?agent_id=<id>`). */
export const AGENT_ID_QUERY_PARAM = "agent_id"

/** Auth query parameters: never passed on to endpoint query parsing. */
export const AUTH_QUERY_PARAMS: readonly string[] = [
  API_KEY_QUERY_PARAM,
  AGENT_ID_QUERY_PARAM,
]

/** The `?api_key=` value of a request URL, if any. */
export function querySecret(url: string | URL | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).searchParams.get(API_KEY_QUERY_PARAM)?.trim() || null
  } catch {
    return null
  }
}

/**
 * Extracts the presented secret from `Authorization: Bearer`, `X-API-Key`
 * or (when `url` is given and no header is sent) `?api_key=`.
 */
export function presentedSecret(
  headers: Headers,
  url?: string | URL
): string | null {
  const auth = headers.get("authorization")
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    return match ? match[1].trim() : null
  }
  return headers.get("x-api-key")?.trim() || querySecret(url)
}

/** Constant-time lookup of the env key matching `secret`. */
export function findApiKey(
  keys: EnvApiKey[],
  secret: string
): EnvApiKey | null {
  const hash = hashSecret(secret)
  let found: EnvApiKey | null = null
  for (const key of keys) {
    if (sameHash(key.secretHash, hash) && !found) found = key
  }
  return found
}

function findManagedKey(
  keys: ApiKeyRecord[],
  secret: string
): ApiKeyRecord | null {
  const hash = hashSecret(secret)
  let found: ApiKeyRecord | null = null
  for (const key of keys) {
    if (sameHash(Buffer.from(key.secretHash, "hex"), hash) && !found) {
      found = key
    }
  }
  return found
}

const AGENT_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/

/** `X-Agent-Id`, else `?agent_id=`. */
function agentHeader(request: Request): string | null {
  const agentId =
    request.headers.get("x-agent-id")?.trim() ||
    new URL(request.url).searchParams.get(AGENT_ID_QUERY_PARAM)?.trim()
  if (!agentId) return null
  if (!AGENT_ID_RE.test(agentId)) {
    throw new ValidationError(
      "Invalid X-Agent-Id header / agent_id parameter (1-128 chars of A-Z a-z 0-9 . _ : @ -)"
    )
  }
  return agentId
}

function actorFor(
  keyId: string,
  access: Access,
  agentId: string | null,
  workspace: string | undefined
): Actor {
  const ws = workspace ? { workspace } : {}
  return agentId
    ? { kind: "agent", id: agentId, viaKeyId: keyId, access, ...ws }
    : { kind: "api_key", id: keyId, access, ...ws }
}

const defaultManagedKeys = async () => (await getStorage()).apiKeys.list()

/**
 * The managed key presenting `secret` and the workspace it belongs to. In
 * multi-workspace mode keys are found across workspaces (by secret hash);
 * otherwise among the instance's keys.
 */
async function findManagedKeyFor(
  secret: string,
  managedKeys: (() => Promise<ApiKeyRecord[]>) | undefined
): Promise<{ key: ApiKeyRecord; workspace: string | null } | null> {
  if (!managedKeys && multiWorkspaceEnabled()) {
    const storage = await getStorage()
    if (storage.findApiKeyBySecretHash) {
      return storage.findApiKeyBySecretHash(hashSecret(secret).toString("hex"))
    }
  }
  const key = findManagedKey(
    await (managedKeys ?? defaultManagedKeys)(),
    secret
  )
  return key && { key, workspace: null }
}

/**
 * Resolves the principal of a request or throws `UnauthorizedError` (→ 401;
 * also for revoked keys), `ValidationError` (bad X-Agent-Id) or
 * `ForbiddenError` (X-Agent-Id differs from the key's bound agent).
 */
export async function authenticatePrincipal(
  request: Request,
  { envKeys = apiKeysFromEnv(), managedKeys }: AuthOptions = {}
): Promise<Principal> {
  const secret = presentedSecret(request.headers, request.url)
  if (!secret) throw new UnauthorizedError()
  const agentId = agentHeader(request)

  // OAuth access token (ChatGPT connectors and other OAuth-only clients).
  const oauth = oauthConfigFromEnv()
  if (oauth && looksLikeJwt(secret)) {
    const id = await verifyOAuthToken(secret, oauth)
    const name = (agentId ?? `oauth:${id.email ?? id.sub}`).slice(0, 128)
    return {
      actor: {
        kind: "agent",
        id: name,
        access: { role: id.role, scope: null },
        ...(multiWorkspaceEnabled() && {
          workspace: actorWorkspace(id.workspace),
        }),
      },
      keyId: `oauth:${id.sub}`,
      rateLimitPerMinute: null,
    }
  }

  const envKey = findApiKey(envKeys, secret)
  if (envKey) {
    return {
      actor: actorFor(
        envKey.id,
        { role: envKey.role, scope: null },
        agentId,
        actorWorkspace(null)
      ),
      keyId: envKey.id,
      rateLimitPerMinute: null,
    }
  }

  const found = await findManagedKeyFor(secret, managedKeys)
  const managed = found?.key
  if (!managed || managed.revokedAt) throw new UnauthorizedError()
  const access: Access = {
    role: managed.role,
    scope: managed.role === "admin" ? null : managed.scope,
  }
  const bound = managed.agentId ?? null
  if (bound && agentId && agentId !== bound) {
    throw new ForbiddenError(
      `API key "${managed.id}" is bound to agent "${bound}"`,
      { agentId: bound }
    )
  }
  return {
    actor: actorFor(
      managed.id,
      access,
      bound ?? agentId,
      actorWorkspace(found.workspace)
    ),
    keyId: managed.id,
    rateLimitPerMinute: managed.rateLimitPerMinute ?? null,
  }
}

/** The actor of a request (see `authenticatePrincipal`). */
export async function authenticateRequest(
  request: Request,
  options?: AuthOptions
): Promise<Actor> {
  return (await authenticatePrincipal(request, options)).actor
}

export const API_RATE_LIMITER = "api"
const MINUTE_MS = 60_000

/**
 * Counts one request against the principal's key. Returns the state for the
 * `RateLimit-*` headers (`null` when unlimited) or throws `RateLimitedError`
 * (→ 429 with `Retry-After`).
 */
export function enforceRateLimit(principal: Principal): RateLimitInfo | null {
  const limit = principal.rateLimitPerMinute ?? rateLimitPerMinuteFromEnv()
  if (limit <= 0) return null
  // Key ids are only unique within a workspace.
  const bucket = multiWorkspaceEnabled()
    ? `${principal.actor.workspace ?? ""}:${principal.keyId}`
    : principal.keyId
  const result = getRateLimiter(API_RATE_LIMITER, MINUTE_MS).consume(
    bucket,
    limit
  )
  const { allowed, ...info } = result
  if (!allowed) throw new RateLimitedError(info)
  return info
}

/** Authentication + rate limiting: what every API / MCP request goes through. */
export async function authorizeRequest(
  request: Request,
  options?: AuthOptions
): Promise<{ principal: Principal; rateLimit: RateLimitInfo | null }> {
  const principal = await authenticatePrincipal(request, options)
  return { principal, rateLimit: enforceRateLimit(principal) }
}

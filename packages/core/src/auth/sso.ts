import { createHmac, timingSafeEqual } from "node:crypto"

import { isWorkspaceSlug, multiWorkspaceEnabled } from "../workspace"

/**
 * SSO token login for the dashboard (cloud-auth ticket 01).
 *
 * A trusted external system (MCPocket Cloud's control plane, or a
 * self-hoster's own identity provider) signs a short-lived compact JWT
 * (HS256, HMAC-SHA256 with `MCPOCKET_SSO_SECRET`) and sends the browser to
 * the instance's SSO endpoint. The instance verifies it here and starts a
 * normal dashboard session for `sub` (an email).
 *
 * Pure (no Next.js imports). Off unless `MCPOCKET_SSO_SECRET` is set.
 *
 * - `MCPOCKET_SSO_SECRET` — shared HMAC key (>= 32 chars recommended)
 * - `MCPOCKET_SSO_WORKSPACE` — optional; when set, the token's `ws` claim
 *   must equal it
 */

export type SsoClaims = {
  /** Email; becomes the session username (`user:<email>` in history). */
  sub: string
  /** Workspace slug; must match `MCPOCKET_SSO_WORKSPACE` when that is set. */
  ws?: string
  /** Unique token id; each token is accepted once. */
  jti: string
  /** Issued at / expires at, epoch seconds. */
  iat: number
  exp: number
}

export type SsoConfig = {
  /** Raw HMAC key (`MCPOCKET_SSO_SECRET`). */
  secret: string
  /** Required `ws` claim, or `null` when any (or no) workspace is accepted. */
  workspace: string | null
  /**
   * Multi-workspace mode: every token must name a valid workspace slug in
   * `ws` (the session acts in it).
   */
  requireWorkspace?: boolean
}

/** Longest accepted token lifetime (`exp - iat`). */
export const SSO_MAX_TOKEN_LIFETIME_SECONDS = 60
/** Tolerated clock skew for an `iat` slightly in the future. */
export const SSO_CLOCK_SKEW_SECONDS = 30
const MAX_TOKEN_LENGTH = 4096
const MAX_JTI_LENGTH = 200
const MAX_EMAIL_LENGTH = 254

export type SsoErrorCode =
  | "missing_token"
  | "malformed"
  | "unsupported_algorithm"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "lifetime_too_long"
  | "missing_subject"
  | "missing_jti"
  | "workspace_mismatch"
  | "missing_workspace"
  | "replayed"

export type SsoVerifyResult =
  | { ok: true; claims: SsoClaims; email: string }
  | { ok: false; reason: SsoErrorCode }

/** `null` = SSO disabled (no `MCPOCKET_SSO_SECRET`). */
export function ssoConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): SsoConfig | null {
  const secret = env.MCPOCKET_SSO_SECRET?.trim()
  if (!secret) return null
  return {
    secret,
    workspace: env.MCPOCKET_SSO_WORKSPACE?.trim() || null,
    ...(multiWorkspaceEnabled(env) && { requireWorkspace: true }),
  }
}

const b64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url")

const hmac = (secret: string, data: string) =>
  createHmac("sha256", secret).update(data).digest()

/** Signs claims as a compact HS256 JWT (used by the mint script and tests). */
export function signSsoToken(
  secret: string,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }
): string {
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  return `${body}.${b64url(hmac(secret, body))}`
}

function parseJsonSegment(segment: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null
  try {
    const value: unknown = JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8")
    )
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const isEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0

/** Plausible email: one `@`, no whitespace/control chars, sane length. */
function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null
  const email = value.trim().toLowerCase()
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) return null
  if (!/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u.test(email)) return null
  return email
}

/**
 * Remembers used `jti`s until their token expires (single process, in
 * memory — one replica per instance). Lives on `globalThis` so every route
 * bundle and dev hot reloads share it.
 */
export class SsoReplayCache {
  private readonly used = new Map<string, number>()

  /** True if `jti` was already used and its token has not expired yet. */
  has(jti: string, nowSeconds: number): boolean {
    const exp = this.used.get(jti)
    return exp !== undefined && exp > nowSeconds
  }

  remember(jti: string, exp: number, nowSeconds: number): void {
    this.prune(nowSeconds)
    this.used.set(jti, exp)
  }

  get size(): number {
    return this.used.size
  }

  clear(): void {
    this.used.clear()
  }

  private prune(nowSeconds: number) {
    for (const [jti, exp] of this.used) {
      if (exp <= nowSeconds) this.used.delete(jti)
    }
  }
}

const globalKey = Symbol.for("mcpocket.ssoReplayCache")
type GlobalWithReplay = typeof globalThis & { [globalKey]?: SsoReplayCache }

export function getSsoReplayCache(): SsoReplayCache {
  const g = globalThis as GlobalWithReplay
  return (g[globalKey] ??= new SsoReplayCache())
}

/** Test helper: forget every used `jti`. */
export function resetSsoReplayCache(): void {
  getSsoReplayCache().clear()
}

/**
 * Verifies an SSO token. On success the `jti` is recorded in `replay`
 * (only after every other check passed), so a second use fails with
 * `replayed`.
 */
export function verifySsoToken(
  config: SsoConfig,
  token: string | null | undefined,
  options: { now?: Date; replay?: SsoReplayCache } = {}
): SsoVerifyResult {
  const fail = (reason: SsoErrorCode): SsoVerifyResult => ({
    ok: false,
    reason,
  })
  const replay = options.replay ?? getSsoReplayCache()
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000)

  if (!token) return fail("missing_token")
  if (token.length > MAX_TOKEN_LENGTH) return fail("malformed")
  const parts = token.split(".")
  if (parts.length !== 3) return fail("malformed")
  const [headerPart, payloadPart, signaturePart] = parts

  const header = parseJsonSegment(headerPart)
  if (!header) return fail("malformed")
  if (header.alg !== "HS256") return fail("unsupported_algorithm")
  if (header.typ !== undefined && header.typ !== "JWT") return fail("malformed")

  if (!/^[A-Za-z0-9_-]+$/.test(signaturePart)) return fail("bad_signature")
  const expected = hmac(config.secret, `${headerPart}.${payloadPart}`)
  const given = Buffer.from(signaturePart, "base64url")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return fail("bad_signature")
  }

  const payload = parseJsonSegment(payloadPart)
  if (!payload) return fail("malformed")
  const { iat, exp, jti, ws } = payload
  if (!isEpoch(iat) || !isEpoch(exp)) return fail("malformed")
  if (exp <= now) return fail("expired")
  if (iat > now + SSO_CLOCK_SKEW_SECONDS) return fail("not_yet_valid")
  if (exp <= iat || exp - iat > SSO_MAX_TOKEN_LIFETIME_SECONDS) {
    return fail("lifetime_too_long")
  }
  const email = normalizeEmail(payload.sub)
  if (!email) return fail("missing_subject")
  if (typeof jti !== "string" || !jti || jti.length > MAX_JTI_LENGTH) {
    return fail("missing_jti")
  }
  if (ws !== undefined && typeof ws !== "string") return fail("malformed")
  if (config.workspace !== null && ws !== config.workspace) {
    return fail("workspace_mismatch")
  }
  if (config.requireWorkspace && !isWorkspaceSlug(ws)) {
    return fail("missing_workspace")
  }
  if (replay.has(jti, now)) return fail("replayed")
  replay.remember(jti, exp, now)

  return {
    ok: true,
    email,
    claims: { sub: payload.sub as string, ws, jti, iat, exp },
  }
}

/** Calm, user-facing explanation per rejection reason (error page copy). */
export const SSO_ERROR_MESSAGES: Record<
  SsoErrorCode,
  { title: string; detail: string }
> = {
  missing_token: {
    title: "No sign-in token",
    detail: "This link did not include a sign-in token.",
  },
  malformed: {
    title: "Unreadable sign-in link",
    detail:
      "The sign-in token is not in the expected format. The link may have been cut off when it was copied.",
  },
  unsupported_algorithm: {
    title: "Unsupported sign-in token",
    detail:
      "The sign-in token uses a signing method this server does not accept.",
  },
  bad_signature: {
    title: "Sign-in link not trusted",
    detail:
      "The sign-in token was not signed with this server's SSO secret, so it was not accepted.",
  },
  expired: {
    title: "Sign-in link expired",
    detail:
      "Sign-in links are only valid for about a minute. Start the sign-in again to get a fresh one.",
  },
  not_yet_valid: {
    title: "Sign-in link not valid yet",
    detail:
      "The sign-in token was issued in the future. The clocks of this server and the issuer may be out of sync.",
  },
  lifetime_too_long: {
    title: "Sign-in link not accepted",
    detail: `Sign-in tokens may be valid for at most ${SSO_MAX_TOKEN_LIFETIME_SECONDS} seconds; this one asked for longer.`,
  },
  missing_subject: {
    title: "No account in sign-in link",
    detail:
      "The sign-in token does not name a valid email address to sign in as.",
  },
  missing_jti: {
    title: "Sign-in link not accepted",
    detail: "The sign-in token is missing its unique id.",
  },
  workspace_mismatch: {
    title: "Wrong workspace",
    detail: "This sign-in link was issued for a different workspace.",
  },
  missing_workspace: {
    title: "No workspace in sign-in link",
    detail:
      "This server hosts several workspaces, and the sign-in link did not say which one to open.",
  },
  replayed: {
    title: "Sign-in link already used",
    detail:
      "Each sign-in link works only once. Start the sign-in again to get a fresh one.",
  },
}

export function isSsoErrorCode(value: unknown): value is SsoErrorCode {
  return typeof value === "string" && Object.hasOwn(SSO_ERROR_MESSAGES, value)
}

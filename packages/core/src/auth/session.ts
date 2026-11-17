import { createHash, createHmac, timingSafeEqual } from "node:crypto"

/**
 * Dashboard admin authentication + stateless signed session tokens.
 *
 * Pure (no Next.js imports) so it is shared by `proxy.ts` (optimistic
 * redirect), the server-only DAL (`lib/auth/server.ts`) and unit tests.
 *
 * Credentials come from the environment (see README "Dashboard"):
 * - `MCPOCKET_ADMIN_USERNAME` (default `admin`)
 * - `MCPOCKET_ADMIN_PASSWORD` (required; login is disabled without it)
 * - `MCPOCKET_SESSION_SECRET` (HMAC key, >= 32 chars recommended; when unset
 *   a key is derived from the admin password so sessions still work)
 * - `MCPOCKET_SESSION_TTL_HOURS` (default 12)
 * - `MCPOCKET_PASSWORD_LOGIN` (default enabled): `false`/`0`/`off`/`no`
 *   disables password login — no password sessions are issued or accepted
 *   (SSO-only mode, see `./login-mode.ts`)
 * - `MCPOCKET_SSO_SECRET` (optional): enables SSO token login (`./sso.ts`).
 *   SSO sessions carry `via: "sso"` and the person's email as `sub`; they
 *   are bound to the SSO secret instead of the admin credentials.
 *
 * The browser only ever holds the signed session cookie, never an API key.
 */

export const SESSION_COOKIE = "mcpocket_session"
export const DEFAULT_SESSION_TTL_HOURS = 12
const TOKEN_VERSION = "v1"

export type SessionPayload = {
  /** Admin username, or the person's email for SSO sessions. */
  sub: string
  /** How the session was started; absent = password login (admin). */
  via?: "sso"
  /** SSO sessions: the token's workspace (`ws` claim), if any. */
  ws?: string
  /** Issued at / expires at, epoch seconds. */
  iat: number
  exp: number
  /**
   * Credential fingerprint: changing username/password (password sessions)
   * or the SSO secret (SSO sessions) invalidates sessions.
   */
  fp: string
}

export type AdminConfig = {
  username: string
  /** sha256 of the admin password; `null` = login disabled (not configured). */
  passwordHash: Buffer | null
  /** `false` when `MCPOCKET_PASSWORD_LOGIN` switches password login off. */
  passwordLogin: boolean
  /** HMAC key for session tokens; `null` when not configured. */
  secret: Buffer | null
  /** True when the secret was derived from the password or SSO secret (no explicit secret). */
  derivedSecret: boolean
  /** sha256 of `MCPOCKET_SSO_SECRET`; `null` = SSO disabled. */
  ssoSecretHash: Buffer | null
  sessionTtlSeconds: number
}

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest()

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url")

const PASSWORD_LOGIN_OFF = new Set(["false", "0", "off", "no"])

/** `MCPOCKET_PASSWORD_LOGIN` — enabled unless explicitly switched off. */
export function passwordLoginEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const value = env.MCPOCKET_PASSWORD_LOGIN?.trim().toLowerCase()
  return !value || !PASSWORD_LOGIN_OFF.has(value)
}

export function adminConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): AdminConfig {
  const username = env.MCPOCKET_ADMIN_USERNAME?.trim() || "admin"
  const password = env.MCPOCKET_ADMIN_PASSWORD
  const passwordHash = password ? sha256(password) : null
  const ssoSecret = env.MCPOCKET_SSO_SECRET?.trim()
  const ssoSecretHash = ssoSecret ? sha256(ssoSecret) : null
  const explicitSecret = env.MCPOCKET_SESSION_SECRET?.trim()
  const secret = explicitSecret
    ? sha256(`mcpocket-session:${explicitSecret}`)
    : passwordHash
      ? sha256(Buffer.concat([Buffer.from("mcpocket-derived:"), passwordHash]))
      : ssoSecretHash
        ? sha256(
            Buffer.concat([Buffer.from("mcpocket-sso-derived:"), ssoSecretHash])
          )
        : null
  const hours = Number(env.MCPOCKET_SESSION_TTL_HOURS)
  const ttlHours =
    Number.isFinite(hours) && hours > 0 && hours <= 24 * 90
      ? hours
      : DEFAULT_SESSION_TTL_HOURS
  return {
    username,
    passwordHash,
    passwordLogin: passwordLoginEnabled(env),
    secret,
    derivedSecret: !explicitSecret,
    ssoSecretHash,
    sessionTtlSeconds: Math.round(ttlHours * 3600),
  }
}

/** Password login is usable: a password is set and it is not switched off. */
export function isAdminConfigured(config: AdminConfig): boolean {
  return (
    config.passwordLogin &&
    config.passwordHash !== null &&
    config.secret !== null
  )
}

/** SSO sessions can be issued/verified (`MCPOCKET_SSO_SECRET` set). */
export function isSsoSessionConfigured(config: AdminConfig): boolean {
  return config.ssoSecretHash !== null && config.secret !== null
}

/** Constant-time credential check (both fields always compared). */
export function checkAdminCredentials(
  config: AdminConfig,
  username: string,
  password: string
): boolean {
  if (!config.passwordHash || !config.passwordLogin) return false
  const userOk = timingSafeEqual(sha256(username), sha256(config.username))
  const passOk = timingSafeEqual(sha256(password), config.passwordHash)
  return userOk && passOk
}

function fingerprint(config: AdminConfig): string {
  return createHmac("sha256", config.secret!)
    .update(`${config.username}\0`)
    .update(config.passwordHash!)
    .digest("base64url")
    .slice(0, 16)
}

function ssoFingerprint(config: AdminConfig, sub: string): string {
  return createHmac("sha256", config.secret!)
    .update(`sso\0${sub}\0`)
    .update(config.ssoSecretHash!)
    .digest("base64url")
    .slice(0, 16)
}

function sign(secret: Buffer, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest()
}

/** Issues a signed token `v1.<payload>.<sig>` for the configured admin. */
export function createSessionToken(
  config: AdminConfig,
  now: Date = new Date()
): { token: string; payload: SessionPayload; expiresAt: Date } {
  if (!isAdminConfigured(config)) {
    throw new Error("Dashboard admin is not configured")
  }
  const iat = Math.floor(now.getTime() / 1000)
  return issue(config, {
    sub: config.username,
    iat,
    exp: iat + config.sessionTtlSeconds,
    fp: fingerprint(config),
  })
}

/**
 * Issues a session token for a person signed in via SSO (`sub` = email,
 * already verified by `verifySsoToken`). Same cookie, TTL and format as a
 * password session.
 */
export function createSsoSessionToken(
  config: AdminConfig,
  email: string,
  now: Date = new Date(),
  workspace?: string
): { token: string; payload: SessionPayload; expiresAt: Date } {
  if (!isSsoSessionConfigured(config)) {
    throw new Error("SSO login is not configured")
  }
  const iat = Math.floor(now.getTime() / 1000)
  return issue(config, {
    sub: email,
    via: "sso",
    ...(workspace && { ws: workspace }),
    iat,
    exp: iat + config.sessionTtlSeconds,
    fp: ssoFingerprint(config, email),
  })
}

function issue(
  config: AdminConfig,
  payload: SessionPayload
): { token: string; payload: SessionPayload; expiresAt: Date } {
  const body = `${TOKEN_VERSION}.${b64url(JSON.stringify(payload))}`
  const token = `${body}.${b64url(sign(config.secret!, body))}`
  return { token, payload, expiresAt: new Date(payload.exp * 1000) }
}

/**
 * Returns the payload of a valid, unexpired token for the current admin (or,
 * with SSO enabled, for an SSO-signed-in person), else `null`.
 */
export function verifySessionToken(
  config: AdminConfig,
  token: string | undefined | null,
  now: Date = new Date()
): SessionPayload | null {
  if (!token || !config.secret) return null
  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null
  const body = `${parts[0]}.${parts[1]}`
  const expected = sign(config.secret!, body)
  const given = Buffer.from(parts[2], "base64url")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null
  }
  let payload: SessionPayload
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (
    typeof payload?.sub !== "string" ||
    typeof payload.exp !== "number" ||
    payload.exp * 1000 <= now.getTime()
  ) {
    return null
  }
  if (payload.via === "sso") {
    if (!isSsoSessionConfigured(config)) return null
    if (payload.ws !== undefined && typeof payload.ws !== "string") return null
    if (payload.fp !== ssoFingerprint(config, payload.sub)) return null
    return payload
  }
  if (
    payload.via !== undefined ||
    !isAdminConfigured(config) ||
    payload.sub !== config.username ||
    payload.fp !== fingerprint(config)
  ) {
    return null
  }
  return payload
}

/** Only same-app dashboard paths are allowed as post-login redirect targets. */
export function safeRedirectPath(
  value: unknown,
  fallback = "/dashboard"
): string {
  if (typeof value !== "string") return fallback
  if (!/^\/dashboard(?:[/?#]|$)/.test(value)) return fallback
  if (value.includes("//") || value.includes("\\")) return fallback
  return value
}

/** Cookie attributes for the session cookie. */
export function sessionCookieOptions(
  expiresAt: Date,
  env: Record<string, string | undefined> = process.env
) {
  const secureEnv = env.MCPOCKET_COOKIE_SECURE?.trim().toLowerCase()
  const secure =
    secureEnv === "true"
      ? true
      : secureEnv === "false"
        ? false
        : env.NODE_ENV === "production"
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  }
}

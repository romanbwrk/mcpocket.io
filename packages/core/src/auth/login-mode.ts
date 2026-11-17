import { passwordLoginEnabled, safeRedirectPath } from "./session"

export { passwordLoginEnabled }

/**
 * How people sign in to the dashboard (cloud-auth ticket 02: SSO-only mode
 * for managed instances).
 *
 * Pure (no Next.js imports): shared by `proxy.ts`, the login page, the
 * sign-out action and tests. Every variable is optional; unset means the
 * self-hosted default (password form at `/login`, sign-out back to it).
 *
 * - `MCPOCKET_SSO_LOGIN_URL` — absolute http(s) URL of the external sign-in
 *   page (MCPocket Cloud's control plane or your identity provider).
 *   Anonymous visitors of `/dashboard/*` and `/login` are redirected there
 *   with the requested dashboard path in a `next` query parameter; the
 *   issuer passes it back to `/auth/sso?next=...` (only `/dashboard...` paths
 *   are honoured there, so `next` cannot become an open redirect).
 * - `MCPOCKET_SSO_LOGOUT_URL` — absolute http(s) URL to land on after
 *   sign-out; defaults to `MCPOCKET_SSO_LOGIN_URL` (then `/login`).
 * - `MCPOCKET_PASSWORD_LOGIN` — `false`/`0`/`off`/`no` disables password
 *   login: the form is hidden, submissions are refused and existing password
 *   sessions stop being accepted. Default: enabled.
 *
 * Invalid URLs (not absolute, not http(s), or with embedded credentials) are
 * ignored — treated as unset — with a one-time warning.
 */

export type LoginModeConfig = {
  /** External sign-in page, or `null` (use the local `/login`). */
  ssoLoginUrl: URL | null
  /** Where sign-out lands when set explicitly, else `null`. */
  ssoLogoutUrl: URL | null
  /** Password login allowed (`MCPOCKET_PASSWORD_LOGIN` not disabled). */
  passwordLogin: boolean
}

/** Local sign-in page (used whenever no SSO login URL is configured). */
export const LOCAL_LOGIN_PATH = "/login"
/** Query parameter carrying the requested dashboard path to the SSO login URL. */
export const SSO_NEXT_PARAM = "next"

const warned = new Set<string>()

/** Absolute http(s) URL without credentials, else `null`. */
export function parseExternalUrl(value: string | undefined): URL | null {
  const raw = value?.trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.username || url.password) return null
  return url
}

function urlFromEnv(
  env: Record<string, string | undefined>,
  name: string
): URL | null {
  const raw = env[name]?.trim()
  if (!raw) return null
  const url = parseExternalUrl(raw)
  if (!url && !warned.has(name)) {
    warned.add(name)
    console.warn(
      `[mcpocket] ${name} is not an absolute http(s) URL without credentials; ignoring it.`
    )
  }
  return url
}

export function loginModeFromEnv(
  env: Record<string, string | undefined> = process.env
): LoginModeConfig {
  return {
    ssoLoginUrl: urlFromEnv(env, "MCPOCKET_SSO_LOGIN_URL"),
    ssoLogoutUrl: urlFromEnv(env, "MCPOCKET_SSO_LOGOUT_URL"),
    passwordLogin: passwordLoginEnabled(env),
  }
}

/**
 * The SSO login URL with the requested dashboard path as `next` (dropped
 * unless it is a safe `/dashboard...` path).
 */
export function ssoLoginRedirectUrl(loginUrl: URL, next?: unknown): string {
  const url = new URL(loginUrl)
  const path = safeRedirectPath(next, "")
  if (path) url.searchParams.set(SSO_NEXT_PARAM, path)
  return url.toString()
}

/**
 * True when redirecting to `loginUrl` from `requestUrl` would loop back into
 * this app's own `/login` or `/dashboard` (a misconfiguration).
 */
export function isSelfRedirect(loginUrl: URL, requestUrl: URL): boolean {
  if (loginUrl.origin !== requestUrl.origin) return false
  return /^\/(?:login|dashboard)(?:[/?#]|$)/.test(loginUrl.pathname)
}

/** Where an anonymous visitor signs in: the SSO login URL, else `/login`. */
export function signInUrl(config: LoginModeConfig, next?: unknown): string {
  if (config.ssoLoginUrl) return ssoLoginRedirectUrl(config.ssoLoginUrl, next)
  const path = safeRedirectPath(next, "")
  return path
    ? `${LOCAL_LOGIN_PATH}?${SSO_NEXT_PARAM}=${encodeURIComponent(path)}`
    : LOCAL_LOGIN_PATH
}

/** Where sign-out lands: sign-out URL, else SSO login URL, else `/login`. */
export function signOutUrl(config: LoginModeConfig): string {
  return (
    config.ssoLogoutUrl?.toString() ??
    config.ssoLoginUrl?.toString() ??
    LOCAL_LOGIN_PATH
  )
}

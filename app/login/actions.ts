"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"

import { getRateLimiter, loginRateLimitFromEnv } from "@mcpocket/core/api/rate-limit"
import { endSession, startSession } from "@/lib/auth/server"
import { loginModeFromEnv, signOutUrl } from "@mcpocket/core/auth/login-mode"
import {
  adminConfigFromEnv,
  checkAdminCredentials,
  isAdminConfigured,
  safeRedirectPath,
} from "@mcpocket/core/auth/session"

export type LoginState = {
  error?: string
  fieldErrors?: { username?: string; password?: string }
  username?: string
}

const LoginSchema = z.object({
  username: z.string().trim().min(1, "Username is required").max(200),
  password: z.string().min(1, "Password is required").max(1000),
})

/** Client address for login throttling (first X-Forwarded-For hop, X-Real-IP, else shared bucket). */
async function clientKey(): Promise<string> {
  const h = await headers()
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim()
  return `login:${forwarded || h.get("x-real-ip")?.trim() || "unknown"}`
}

/**
 * Dashboard login. Failed attempts are rate-limited per client
 * (`MCPOCKET_LOGIN_MAX_ATTEMPTS` per `MCPOCKET_LOGIN_WINDOW_SECONDS`); a
 * successful login clears the client's counter. Refused outright when
 * `MCPOCKET_PASSWORD_LOGIN` switches password login off (SSO-only mode).
 */
export async function login(
  _prev: LoginState | undefined,
  formData: FormData
): Promise<LoginState> {
  const config = adminConfigFromEnv()
  if (!config.passwordLogin) {
    return { error: "Password sign-in is disabled on this server." }
  }
  if (!isAdminConfigured(config)) {
    return { error: "Dashboard login is not configured on this server." }
  }
  const parsed = LoginSchema.safeParse({
    username: formData.get("username") ?? "",
    password: formData.get("password") ?? "",
  })
  const username = String(formData.get("username") ?? "")
  if (!parsed.success) {
    const fieldErrors: LoginState["fieldErrors"] = {}
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as "username" | "password"
      fieldErrors[key] ??= issue.message
    }
    return { fieldErrors, username }
  }
  const throttle = loginRateLimitFromEnv()
  const limiter = getRateLimiter("login", throttle.windowSeconds * 1000)
  const key = await clientKey()
  if (throttle.attempts > 0) {
    const state = limiter.peek(key, throttle.attempts)
    if (!state.allowed) {
      return {
        error: `Too many failed login attempts. Try again in ${Math.ceil(state.resetSeconds / 60)} min.`,
        username,
      }
    }
  }
  if (
    !checkAdminCredentials(config, parsed.data.username, parsed.data.password)
  ) {
    if (throttle.attempts > 0) limiter.consume(key, throttle.attempts)
    return { error: "Invalid username or password.", username }
  }
  limiter.reset(key)
  await startSession()
  redirect(safeRedirectPath(formData.get("next")))
}

/**
 * Ends the session, then lands on `MCPOCKET_SSO_LOGOUT_URL`, else
 * `MCPOCKET_SSO_LOGIN_URL`, else `/login`.
 */
export async function logout(): Promise<void> {
  await endSession()
  redirect(signOutUrl(loginModeFromEnv()))
}

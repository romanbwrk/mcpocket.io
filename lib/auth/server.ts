import "server-only"

import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

import { ADMIN_ACCESS } from "@mcpocket/core/domain/access"
import type { Actor } from "@mcpocket/core/domain/actor"
import {
  getServices,
  publicOrigin,
  type Services,
} from "@mcpocket/core/services"
import { loginModeFromEnv, signInUrl } from "@mcpocket/core/auth/login-mode"
import { actorWorkspace } from "@mcpocket/core/workspace"

import {
  adminConfigFromEnv,
  createSessionToken,
  createSsoSessionToken,
  SESSION_COOKIE,
  sessionCookieOptions,
  verifySessionToken,
  type SessionPayload,
} from "@mcpocket/core/auth/session"

/**
 * Dashboard data access layer: the ONLY way dashboard server components and
 * server actions reach application services. Every call re-verifies the
 * signed session cookie (proxy.ts is only an optimistic redirect).
 */

export type DashboardUser = { username: string; expiresAt: string }

/** Verified session of the current request, or `null`. Memoized per render. */
export const getSession = cache(async (): Promise<SessionPayload | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  return verifySessionToken(adminConfigFromEnv(), token)
})

/**
 * Session or redirect to sign in — `/login`, or `MCPOCKET_SSO_LOGIN_URL` in
 * SSO-only mode (works in server components and actions).
 */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession()
  if (!session) redirect(signInUrl(loginModeFromEnv()))
  return session
}

export async function getCurrentUser(): Promise<DashboardUser> {
  const session = await requireSession()
  return {
    username: session.sub,
    expiresAt: new Date(session.exp * 1000).toISOString(),
  }
}

/**
 * The dashboard account is the admin (RBAC role `admin`, unrestricted).
 * People signed in via SSO act as admins too, recorded as `user:<email>`.
 */
export const userActor = (session: SessionPayload): Actor => {
  // Multi-workspace mode: SSO sessions act in their token's workspace.
  const workspace = actorWorkspace(session.ws)
  return {
    kind: "user",
    id: session.sub,
    access: ADMIN_ACCESS,
    ...(workspace && { workspace }),
  }
}

/** Application services bound to the logged-in admin (`user:<name>` in history). */
export async function getUserServices(): Promise<Services> {
  const session = await requireSession()
  return getServices(userActor(session), {
    // Absolute links for media stored from the dashboard (server delivery).
    publicUrl: publicOrigin(await headers()),
  })
}

export async function startSession(): Promise<void> {
  const { token, expiresAt } = createSessionToken(adminConfigFromEnv())
  ;(await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt))
}

/**
 * Same signed session cookie as password login, for an SSO-verified email
 * (and the token's workspace, used in multi-workspace mode).
 */
export async function startSsoSession(
  email: string,
  workspace?: string
): Promise<void> {
  const { token, expiresAt } = createSsoSessionToken(
    adminConfigFromEnv(),
    email,
    new Date(),
    workspace
  )
  ;(await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt))
}

export async function endSession(): Promise<void> {
  ;(await cookies()).delete(SESSION_COOKIE)
}

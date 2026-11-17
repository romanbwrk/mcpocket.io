import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  adminConfigFromEnv,
  createSessionToken,
  createSsoSessionToken,
  SESSION_COOKIE,
} from "@mcpocket/core/auth/session"

import proxy from "./proxy"

const ORIGIN = "http://localhost:3000"

function request(path: string, session?: string) {
  const req = new NextRequest(`${ORIGIN}${path}`)
  if (session) req.cookies.set(SESSION_COOKIE, session)
  return req
}

/** Redirect target of a proxy response, or `null` when it passes through. */
function location(res: Response): string | null {
  return res.status >= 300 && res.status < 400
    ? res.headers.get("location")
    : null
}

beforeEach(() => {
  vi.stubEnv("MCPOCKET_ADMIN_USERNAME", "boss")
  vi.stubEnv("MCPOCKET_ADMIN_PASSWORD", "pw-123456")
  vi.stubEnv("MCPOCKET_SESSION_SECRET", "s".repeat(40))
  vi.stubEnv("MCPOCKET_SSO_LOGIN_URL", "")
  vi.stubEnv("MCPOCKET_SSO_LOGOUT_URL", "")
  vi.stubEnv("MCPOCKET_PASSWORD_LOGIN", "")
})
afterEach(() => vi.unstubAllEnvs())

// Regression: without the SSO-only variables the proxy behaves as before.
describe("proxy without SSO-only settings", () => {
  it("sends anonymous dashboard visitors to /login with `next`", () => {
    const res = proxy(request("/dashboard/tubes/x?tab=1"))
    const url = new URL(location(res)!)
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/login`)
    expect(url.searchParams.get("next")).toBe("/dashboard/tubes/x?tab=1")
  })

  it("lets anonymous visitors see /login and moves admins to /dashboard", () => {
    expect(location(proxy(request("/login?next=/dashboard/a")))).toBeNull()
    const { token } = createSessionToken(adminConfigFromEnv())
    expect(location(proxy(request("/login", token)))).toBe(
      `${ORIGIN}/dashboard`
    )
    expect(location(proxy(request("/dashboard", token)))).toBeNull()
  })
})

describe("proxy with MCPOCKET_SSO_LOGIN_URL", () => {
  beforeEach(() => {
    vi.stubEnv("MCPOCKET_SSO_LOGIN_URL", "https://cloud.example/sso?i=acme")
    vi.stubEnv("MCPOCKET_SSO_SECRET", "sso-secret-".repeat(4))
  })

  it("sends anonymous dashboard visitors there, carrying the path", () => {
    const url = new URL(location(proxy(request("/dashboard/agents?x=1")))!)
    expect(url.origin + url.pathname).toBe("https://cloud.example/sso")
    expect(url.searchParams.get("i")).toBe("acme")
    expect(url.searchParams.get("next")).toBe("/dashboard/agents?x=1")
  })

  it("sends anonymous /login visitors there, keeping a safe `next` only", () => {
    let url = new URL(location(proxy(request("/login?next=%2Fdashboard%2Fa")))!)
    expect(url.origin + url.pathname).toBe("https://cloud.example/sso")
    expect(url.searchParams.get("next")).toBe("/dashboard/a")
    url = new URL(location(proxy(request("/login?next=https://evil.example")))!)
    expect(url.searchParams.has("next")).toBe(false)
  })

  it("lets signed-in people through", () => {
    const { token } = createSsoSessionToken(
      adminConfigFromEnv(),
      "ada@example.com"
    )
    expect(location(proxy(request("/dashboard/agents", token)))).toBeNull()
    expect(location(proxy(request("/login", token)))).toBe(
      `${ORIGIN}/dashboard`
    )
  })

  it("does not loop when the URL points back at this app's /login", () => {
    vi.stubEnv("MCPOCKET_SSO_LOGIN_URL", `${ORIGIN}/login`)
    expect(location(proxy(request("/login")))).toBeNull()
    expect(new URL(location(proxy(request("/dashboard")))!).pathname).toBe(
      "/login"
    )
  })
})

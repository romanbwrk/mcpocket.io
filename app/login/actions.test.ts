import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  adminConfigFromEnv,
  SESSION_COOKIE,
  verifySessionToken,
} from "@mcpocket/core/auth/session"
import { resetRateLimiters } from "@mcpocket/core/api/rate-limit"
import { cookieJar, RedirectError, requestHeaders } from "@/lib/auth/test-utils"

import { login, logout } from "./actions"

vi.mock("server-only", () => ({}))
vi.mock(
  "next/headers",
  async () => (await import("@/lib/auth/test-utils")).nextHeadersMock
)
vi.mock(
  "next/navigation",
  async () => (await import("@/lib/auth/test-utils")).nextNavigationMock
)

const form = (fields: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

beforeEach(() => {
  cookieJar.clear()
  requestHeaders.clear()
  resetRateLimiters()
  vi.stubEnv("MCPOCKET_ADMIN_USERNAME", "boss")
  vi.stubEnv("MCPOCKET_ADMIN_PASSWORD", "pw-123456")
  vi.stubEnv("MCPOCKET_SESSION_SECRET", "s".repeat(40))
})
afterEach(() => vi.unstubAllEnvs())

describe("login action", () => {
  it("sets an httpOnly signed session cookie and redirects", async () => {
    await expect(
      login(undefined, form({ username: "boss", password: "pw-123456" }))
    ).rejects.toMatchObject({ url: "/dashboard" })
    const cookie = cookieJar.get(SESSION_COOKIE)
    expect(cookie?.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    })
    expect(cookie?.value).not.toContain("pw-123456")
    expect(verifySessionToken(adminConfigFromEnv(), cookie?.value)?.sub).toBe(
      "boss"
    )
  })

  it("redirects to a safe `next` path only", async () => {
    const creds = { username: "boss", password: "pw-123456" }
    await expect(
      login(undefined, form({ ...creds, next: "/dashboard/tubes/x" }))
    ).rejects.toMatchObject({ url: "/dashboard/tubes/x" })
    await expect(
      login(undefined, form({ ...creds, next: "https://evil.example" }))
    ).rejects.toMatchObject({ url: "/dashboard" })
  })

  it("rejects wrong credentials without a cookie", async () => {
    const state = await login(
      undefined,
      form({ username: "boss", password: "nope" })
    )
    expect(state).toEqual({
      error: "Invalid username or password.",
      username: "boss",
    })
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false)
  })

  it("reports missing fields", async () => {
    const state = await login(undefined, form({ username: " ", password: "" }))
    expect(state.fieldErrors).toEqual({
      username: "Username is required",
      password: "Password is required",
    })
  })

  it("refuses to log in when no admin password is configured", async () => {
    vi.stubEnv("MCPOCKET_ADMIN_PASSWORD", "")
    const state = await login(
      undefined,
      form({ username: "admin", password: "x" })
    )
    expect(state.error).toMatch(/not configured/)
    expect(cookieJar.size).toBe(0)
  })
})

describe("logout action", () => {
  it("clears the cookie and redirects to /login", async () => {
    cookieJar.set(SESSION_COOKIE, { value: "anything" })
    await expect(logout()).rejects.toBeInstanceOf(RedirectError)
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false)
  })

  // Regression: with the SSO-only variables unset, sign-out stays on /login.
  it("redirects exactly to /login when no SSO URLs are configured", async () => {
    vi.stubEnv("MCPOCKET_SSO_LOGIN_URL", "")
    vi.stubEnv("MCPOCKET_SSO_LOGOUT_URL", "")
    vi.stubEnv("MCPOCKET_PASSWORD_LOGIN", "")
    await expect(logout()).rejects.toMatchObject({ url: "/login" })
  })

  it("returns to the SSO login URL, or a configured sign-out URL", async () => {
    vi.stubEnv("MCPOCKET_SSO_LOGIN_URL", "https://cloud.example/login")
    cookieJar.set(SESSION_COOKIE, { value: "anything" })
    await expect(logout()).rejects.toMatchObject({
      url: "https://cloud.example/login",
    })
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false)

    vi.stubEnv("MCPOCKET_SSO_LOGOUT_URL", "https://cloud.example/signed-out")
    cookieJar.set(SESSION_COOKIE, { value: "anything" })
    await expect(logout()).rejects.toMatchObject({
      url: "https://cloud.example/signed-out",
    })
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false)
  })
})

describe("password login switched off (MCPOCKET_PASSWORD_LOGIN=false)", () => {
  it("rejects correct credentials server side without a cookie", async () => {
    vi.stubEnv("MCPOCKET_PASSWORD_LOGIN", "false")
    const state = await login(
      undefined,
      form({ username: "boss", password: "pw-123456" })
    )
    expect(state.error).toMatch(/disabled/)
    expect(cookieJar.size).toBe(0)
  })
})

describe("requireSession", () => {
  it("sends anonymous users to /login, or to the SSO login URL", async () => {
    const { requireSession } = await import("@/lib/auth/server")
    await expect(requireSession()).rejects.toMatchObject({ url: "/login" })
    vi.stubEnv("MCPOCKET_SSO_LOGIN_URL", "https://cloud.example/login")
    await expect(requireSession()).rejects.toMatchObject({
      url: "https://cloud.example/login",
    })
  })
})

describe("login throttling", () => {
  const bad = () => form({ username: "boss", password: "wrong-pw" })
  const good = () => form({ username: "boss", password: "pw-123456" })

  it("blocks a client after too many failed attempts, per IP", async () => {
    vi.stubEnv("MCPOCKET_LOGIN_MAX_ATTEMPTS", "3")
    requestHeaders.set("x-forwarded-for", "203.0.113.7, 10.0.0.1")
    for (let i = 0; i < 3; i++) {
      expect((await login(undefined, bad())).error).toMatch(/Invalid/)
    }
    // even the right password is refused while blocked
    expect((await login(undefined, good())).error).toMatch(/Too many/)
    expect(cookieJar.size).toBe(0)

    requestHeaders.set("x-forwarded-for", "198.51.100.2")
    await expect(login(undefined, good())).rejects.toBeInstanceOf(RedirectError)
  })

  it("resets the counter after a successful login", async () => {
    vi.stubEnv("MCPOCKET_LOGIN_MAX_ATTEMPTS", "2")
    await login(undefined, bad())
    await expect(login(undefined, good())).rejects.toBeInstanceOf(RedirectError)
    await login(undefined, bad())
    expect((await login(undefined, bad())).error).toMatch(/Invalid/)
    expect((await login(undefined, bad())).error).toMatch(/Too many/)
  })
})

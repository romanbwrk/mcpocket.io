import { describe, expect, it } from "vitest"

import {
  adminConfigFromEnv,
  checkAdminCredentials,
  createSessionToken,
  isAdminConfigured,
  safeRedirectPath,
  sessionCookieOptions,
  verifySessionToken,
} from "./session"

const env = {
  MCPOCKET_ADMIN_USERNAME: "root",
  MCPOCKET_ADMIN_PASSWORD: "correct horse",
  MCPOCKET_SESSION_SECRET: "x".repeat(40),
}
const config = adminConfigFromEnv(env)
const T0 = new Date("2026-01-01T00:00:00Z")

describe("admin config", () => {
  it("is disabled without a password", () => {
    const c = adminConfigFromEnv({})
    expect(c.username).toBe("admin")
    expect(isAdminConfigured(c)).toBe(false)
    expect(checkAdminCredentials(c, "admin", "")).toBe(false)
    expect(() => createSessionToken(c)).toThrow(/not configured/)
  })

  it("derives a secret from the password when none is set", () => {
    const c = adminConfigFromEnv({ MCPOCKET_ADMIN_PASSWORD: "pw" })
    expect(isAdminConfigured(c)).toBe(true)
    expect(c.derivedSecret).toBe(true)
    const { token } = createSessionToken(c, T0)
    expect(verifySessionToken(c, token, T0)?.sub).toBe("admin")
  })

  it("parses TTL hours with a sane default", () => {
    expect(adminConfigFromEnv(env).sessionTtlSeconds).toBe(12 * 3600)
    expect(
      adminConfigFromEnv({ ...env, MCPOCKET_SESSION_TTL_HOURS: "1.5" })
        .sessionTtlSeconds
    ).toBe(5400)
    expect(
      adminConfigFromEnv({ ...env, MCPOCKET_SESSION_TTL_HOURS: "nope" })
        .sessionTtlSeconds
    ).toBe(12 * 3600)
  })
})

describe("password login switch (MCPOCKET_PASSWORD_LOGIN)", () => {
  it("is on by default and off for false values", () => {
    expect(config.passwordLogin).toBe(true)
    const off = adminConfigFromEnv({ ...env, MCPOCKET_PASSWORD_LOGIN: "false" })
    expect(off.passwordLogin).toBe(false)
    expect(isAdminConfigured(off)).toBe(false)
    expect(checkAdminCredentials(off, "root", "correct horse")).toBe(false)
    expect(() => createSessionToken(off)).toThrow(/not configured/)
  })

  it("stops accepting existing password sessions when switched off", () => {
    const { token } = createSessionToken(config, T0)
    const off = adminConfigFromEnv({ ...env, MCPOCKET_PASSWORD_LOGIN: "off" })
    expect(verifySessionToken(config, token, T0)?.sub).toBe("root")
    expect(verifySessionToken(off, token, T0)).toBeNull()
  })
})

describe("credentials", () => {
  it("accepts only the exact username and password", () => {
    expect(checkAdminCredentials(config, "root", "correct horse")).toBe(true)
    expect(checkAdminCredentials(config, "root", "correct horse ")).toBe(false)
    expect(checkAdminCredentials(config, "admin", "correct horse")).toBe(false)
    expect(checkAdminCredentials(config, "root", "")).toBe(false)
  })
})

describe("session tokens", () => {
  it("round-trips and expires after the TTL", () => {
    const { token, payload, expiresAt } = createSessionToken(config, T0)
    expect(payload.sub).toBe("root")
    expect(expiresAt.getTime()).toBe(T0.getTime() + 12 * 3600 * 1000)
    expect(token).not.toContain("correct horse")
    expect(verifySessionToken(config, token, T0)).toEqual(payload)
    expect(
      verifySessionToken(config, token, new Date(expiresAt.getTime() - 1000))
    ).not.toBeNull()
    expect(verifySessionToken(config, token, expiresAt)).toBeNull()
  })

  it("rejects tampered, malformed and foreign tokens", () => {
    const { token } = createSessionToken(config, T0)
    const [v, body, sig] = token.split(".")
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, "base64url").toString()),
        exp: 9e9,
      })
    ).toString("base64url")
    expect(verifySessionToken(config, `${v}.${forged}.${sig}`, T0)).toBeNull()
    expect(verifySessionToken(config, `${v}.${body}.${sig}x`, T0)).toBeNull()
    expect(verifySessionToken(config, "garbage", T0)).toBeNull()
    expect(verifySessionToken(config, "", T0)).toBeNull()
    expect(verifySessionToken(config, undefined, T0)).toBeNull()
    const other = adminConfigFromEnv({
      ...env,
      MCPOCKET_SESSION_SECRET: "y".repeat(40),
    })
    expect(verifySessionToken(other, token, T0)).toBeNull()
  })

  it("is invalidated when the admin credentials change", () => {
    const { token } = createSessionToken(config, T0)
    const newPw = adminConfigFromEnv({ ...env, MCPOCKET_ADMIN_PASSWORD: "new" })
    const newUser = adminConfigFromEnv({
      ...env,
      MCPOCKET_ADMIN_USERNAME: "other",
    })
    expect(verifySessionToken(newPw, token, T0)).toBeNull()
    expect(verifySessionToken(newUser, token, T0)).toBeNull()
  })
})

describe("helpers", () => {
  it.each([
    ["/dashboard", "/dashboard"],
    ["/dashboard/tubes/abc?x=1", "/dashboard/tubes/abc?x=1"],
    ["/dashboardx", "/dashboard"],
    ["https://evil.example/dashboard", "/dashboard"],
    ["//evil.example", "/dashboard"],
    ["/dashboard//evil.example", "/dashboard"],
    ["/dashboard\\evil", "/dashboard"],
    [null, "/dashboard"],
  ])("safeRedirectPath(%j) → %s", (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected)
  })

  it("sets hardened cookie options", () => {
    const exp = new Date(T0)
    expect(sessionCookieOptions(exp, { NODE_ENV: "production" })).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      expires: exp,
    })
    expect(sessionCookieOptions(exp, { NODE_ENV: "development" }).secure).toBe(
      false
    )
    expect(
      sessionCookieOptions(exp, {
        NODE_ENV: "production",
        MCPOCKET_COOKIE_SECURE: "false",
      }).secure
    ).toBe(false)
  })
})

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  isSelfRedirect,
  loginModeFromEnv,
  parseExternalUrl,
  passwordLoginEnabled,
  signInUrl,
  signOutUrl,
  ssoLoginRedirectUrl,
} from "./login-mode"

afterEach(() => vi.restoreAllMocks())

describe("loginModeFromEnv", () => {
  it("defaults to the self-hosted behaviour when nothing is set", () => {
    const mode = loginModeFromEnv({})
    expect(mode).toEqual({
      ssoLoginUrl: null,
      ssoLogoutUrl: null,
      passwordLogin: true,
    })
    expect(signInUrl(mode)).toBe("/login")
    expect(signInUrl(mode, "/dashboard/agents")).toBe(
      "/login?next=%2Fdashboard%2Fagents"
    )
    expect(signOutUrl(mode)).toBe("/login")
  })

  it("reads the SSO login and sign-out URLs", () => {
    const mode = loginModeFromEnv({
      MCPOCKET_SSO_LOGIN_URL: " https://cloud.example/login?i=acme ",
      MCPOCKET_SSO_LOGOUT_URL: "https://cloud.example/bye",
    })
    expect(mode.ssoLoginUrl?.toString()).toBe(
      "https://cloud.example/login?i=acme"
    )
    expect(signOutUrl(mode)).toBe("https://cloud.example/bye")
    expect(signOutUrl({ ...mode, ssoLogoutUrl: null })).toBe(
      "https://cloud.example/login?i=acme"
    )
  })

  it("ignores invalid URLs (treated as unset) with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const bad of [
      "/relative",
      "javascript:alert(1)",
      "ftp://cloud.example",
      "https://user:pw@cloud.example",
      "not a url",
    ]) {
      expect(parseExternalUrl(bad)).toBeNull()
    }
    expect(
      loginModeFromEnv({ MCPOCKET_SSO_LOGOUT_URL: "javascript:x" }).ssoLogoutUrl
    ).toBeNull()
    expect(warn).toHaveBeenCalled()
    expect(parseExternalUrl("http://localhost:4000/sso")?.host).toBe(
      "localhost:4000"
    )
  })

  it("switches password login off only for explicit false values", () => {
    for (const off of ["false", "0", "off", "no", " FALSE "]) {
      expect(passwordLoginEnabled({ MCPOCKET_PASSWORD_LOGIN: off })).toBe(false)
    }
    for (const on of [undefined, "", "true", "1", "yes"]) {
      expect(passwordLoginEnabled({ MCPOCKET_PASSWORD_LOGIN: on })).toBe(true)
    }
  })
})

describe("ssoLoginRedirectUrl", () => {
  const login = new URL("https://cloud.example/sso/start?i=acme")

  it("carries a safe dashboard path as `next`, keeping existing params", () => {
    const url = new URL(ssoLoginRedirectUrl(login, "/dashboard/tubes/x?tab=1"))
    expect(url.origin + url.pathname).toBe("https://cloud.example/sso/start")
    expect(url.searchParams.get("i")).toBe("acme")
    expect(url.searchParams.get("next")).toBe("/dashboard/tubes/x?tab=1")
  })

  it("drops unsafe or missing `next` values", () => {
    for (const next of [
      undefined,
      null,
      "",
      "https://evil.example",
      "//evil.example",
      "/dashboard//evil.example",
      "/api/items",
    ]) {
      expect(
        new URL(ssoLoginRedirectUrl(login, next)).searchParams.has("next")
      ).toBe(false)
    }
  })
})

describe("isSelfRedirect", () => {
  const req = new URL("http://localhost:3000/dashboard")
  it("detects a login URL pointing back at this app's /login or /dashboard", () => {
    expect(isSelfRedirect(new URL("http://localhost:3000/login"), req)).toBe(
      true
    )
    expect(
      isSelfRedirect(new URL("http://localhost:3000/dashboard/x"), req)
    ).toBe(true)
    expect(isSelfRedirect(new URL("http://localhost:3000/sso"), req)).toBe(
      false
    )
    expect(isSelfRedirect(new URL("https://cloud.example/login"), req)).toBe(
      false
    )
  })
})

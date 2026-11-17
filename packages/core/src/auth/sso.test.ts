import { createHmac } from "node:crypto"

import { beforeEach, describe, expect, it } from "vitest"

import {
  adminConfigFromEnv,
  createSessionToken,
  createSsoSessionToken,
  isSsoSessionConfigured,
  verifySessionToken,
} from "./session"
import {
  signSsoToken,
  ssoConfigFromEnv,
  SsoReplayCache,
  verifySsoToken,
  type SsoConfig,
} from "./sso"

const SECRET = "sso-".repeat(10)
const T0 = new Date("2026-01-01T00:00:00Z")
const NOW = Math.floor(T0.getTime() / 1000)
const config: SsoConfig = { secret: SECRET, workspace: null }

let replay: SsoReplayCache
beforeEach(() => {
  replay = new SsoReplayCache()
})

const claims = (overrides: Record<string, unknown> = {}) => ({
  sub: "Ada@Example.com",
  jti: `jti-${Math.random()}`,
  iat: NOW,
  exp: NOW + 60,
  ...overrides,
})
const verify = (token: string | null, c: SsoConfig = config, now = T0) =>
  verifySsoToken(c, token, { now, replay })
const reason = (token: string | null, c?: SsoConfig, now?: Date) => {
  const result = verify(token, c, now)
  return result.ok ? "ok" : result.reason
}
const b64 = (value: unknown) =>
  Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value)
  ).toString("base64url")

describe("ssoConfigFromEnv", () => {
  it("is off without MCPOCKET_SSO_SECRET", () => {
    expect(ssoConfigFromEnv({})).toBeNull()
    expect(ssoConfigFromEnv({ MCPOCKET_SSO_SECRET: "  " })).toBeNull()
  })

  it("reads the secret and optional workspace", () => {
    expect(
      ssoConfigFromEnv({
        MCPOCKET_SSO_SECRET: SECRET,
        MCPOCKET_SSO_WORKSPACE: " acme ",
      })
    ).toEqual({ secret: SECRET, workspace: "acme" })
    expect(ssoConfigFromEnv({ MCPOCKET_SSO_SECRET: SECRET })?.workspace).toBe(
      null
    )
  })
})

describe("verifySsoToken", () => {
  it("accepts a valid token and normalizes the email", () => {
    const c = claims()
    const result = verify(signSsoToken(SECRET, c))
    expect(result).toEqual({
      ok: true,
      email: "ada@example.com",
      claims: { sub: c.sub, jti: c.jti, iat: c.iat, exp: c.exp, ws: undefined },
    })
  })

  it("rejects a missing or malformed token", () => {
    expect(reason(null)).toBe("missing_token")
    expect(reason("")).toBe("missing_token")
    expect(reason("not-a-jwt")).toBe("malformed")
    expect(reason("a.b.c.d")).toBe("malformed")
    expect(reason(`${b64("nope")}.${b64(claims())}.sig`)).toBe("malformed")
    expect(reason("x".repeat(5000))).toBe("malformed")
  })

  it("rejects a bad signature", () => {
    const token = signSsoToken(SECRET, claims())
    expect(reason(signSsoToken("other-secret", claims()))).toBe("bad_signature")
    expect(reason(`${token}x`)).toBe("bad_signature")
    expect(reason(token.slice(0, token.lastIndexOf(".") + 1))).toBe(
      "bad_signature"
    )
    // tampered payload, original signature
    const [h, , s] = token.split(".")
    expect(reason(`${h}.${b64(claims({ sub: "eve@example.com" }))}.${s}`)).toBe(
      "bad_signature"
    )
  })

  it("rejects the wrong algorithm (incl. alg=none and HS512)", () => {
    expect(reason(signSsoToken(SECRET, claims(), { alg: "none" }))).toBe(
      "unsupported_algorithm"
    )
    expect(reason(`${b64({ alg: "none" })}.${b64(claims())}.`)).toBe(
      "unsupported_algorithm"
    )
    const body = `${b64({ alg: "HS512", typ: "JWT" })}.${b64(claims())}`
    const sig = createHmac("sha512", SECRET).update(body).digest("base64url")
    expect(reason(`${body}.${sig}`)).toBe("unsupported_algorithm")
    expect(reason(signSsoToken(SECRET, claims(), { alg: "RS256" }))).toBe(
      "unsupported_algorithm"
    )
    expect(reason(signSsoToken(SECRET, claims(), {}))).toBe(
      "unsupported_algorithm"
    )
  })

  it("rejects an expired token", () => {
    expect(
      reason(signSsoToken(SECRET, claims({ iat: NOW - 61, exp: NOW - 1 })))
    ).toBe("expired")
    const token = signSsoToken(SECRET, claims())
    expect(reason(token, config, new Date((NOW + 60) * 1000))).toBe("expired")
  })

  it("rejects exp more than 60 s after iat", () => {
    expect(reason(signSsoToken(SECRET, claims({ exp: NOW + 61 })))).toBe(
      "lifetime_too_long"
    )
    expect(
      reason(signSsoToken(SECRET, claims({ iat: NOW - 3600, exp: NOW + 3600 })))
    ).toBe("lifetime_too_long")
    expect(
      reason(signSsoToken(SECRET, claims({ iat: NOW + 5, exp: NOW + 5 })))
    ).toBe("lifetime_too_long")
    expect(reason(signSsoToken(SECRET, claims({ exp: NOW + 60 })))).toBe("ok")
  })

  it("rejects an iat too far in the future", () => {
    expect(
      reason(signSsoToken(SECRET, claims({ iat: NOW + 40, exp: NOW + 90 })))
    ).toBe("not_yet_valid")
    expect(
      reason(signSsoToken(SECRET, claims({ iat: NOW + 10, exp: NOW + 60 })))
    ).toBe("ok")
  })

  it("rejects non-numeric times", () => {
    expect(reason(signSsoToken(SECRET, claims({ exp: "soon" })))).toBe(
      "malformed"
    )
    expect(reason(signSsoToken(SECRET, claims({ iat: undefined })))).toBe(
      "malformed"
    )
  })

  it("rejects a missing or invalid sub", () => {
    for (const sub of [
      undefined,
      null,
      "",
      "   ",
      42,
      "no-at-sign",
      "a b@c.d",
    ]) {
      expect(reason(signSsoToken(SECRET, claims({ sub })))).toBe(
        "missing_subject"
      )
    }
  })

  it("rejects a missing jti", () => {
    for (const jti of [undefined, "", 7, "j".repeat(201)]) {
      expect(reason(signSsoToken(SECRET, claims({ jti })))).toBe("missing_jti")
    }
  })

  it("enforces the workspace only when MCPOCKET_SSO_WORKSPACE is set", () => {
    const acme: SsoConfig = { secret: SECRET, workspace: "acme" }
    expect(reason(signSsoToken(SECRET, claims({ ws: "acme" })), acme)).toBe(
      "ok"
    )
    expect(reason(signSsoToken(SECRET, claims({ ws: "other" })), acme)).toBe(
      "workspace_mismatch"
    )
    expect(reason(signSsoToken(SECRET, claims()), acme)).toBe(
      "workspace_mismatch"
    )
    expect(reason(signSsoToken(SECRET, claims({ ws: "whatever" })))).toBe("ok")
    expect(reason(signSsoToken(SECRET, claims({ ws: 5 })))).toBe("malformed")
  })

  it("rejects a reused jti until it expires", () => {
    const c = claims({ jti: "once" })
    const token = signSsoToken(SECRET, c)
    expect(reason(token)).toBe("ok")
    expect(reason(token)).toBe("replayed")
    // a different token with the same jti is a replay too
    expect(reason(signSsoToken(SECRET, { ...c, sub: "bob@example.com" }))).toBe(
      "replayed"
    )
    expect(replay.size).toBe(1)
  })

  it("does not burn the jti of a token rejected for another reason", () => {
    const acme: SsoConfig = { secret: SECRET, workspace: "acme" }
    const c = claims({ jti: "keep", ws: "acme" })
    expect(reason(signSsoToken(SECRET, { ...c, ws: "other" }), acme)).toBe(
      "workspace_mismatch"
    )
    expect(reason(signSsoToken(SECRET, c), acme)).toBe("ok")
  })

  it("forgets used jtis once their token has expired", () => {
    const cache = new SsoReplayCache()
    cache.remember("a", NOW + 10, NOW)
    expect(cache.has("a", NOW + 9)).toBe(true)
    expect(cache.has("a", NOW + 10)).toBe(false)
    cache.remember("b", NOW + 100, NOW + 20)
    expect(cache.size).toBe(1)
  })
})

describe("SSO sessions", () => {
  const env = {
    MCPOCKET_ADMIN_USERNAME: "root",
    MCPOCKET_ADMIN_PASSWORD: "correct horse",
    MCPOCKET_SESSION_SECRET: "x".repeat(40),
    MCPOCKET_SSO_SECRET: SECRET,
  }

  it("round-trips with the email as sub", () => {
    const c = adminConfigFromEnv(env)
    const { token, payload } = createSsoSessionToken(c, "ada@example.com", T0)
    expect(payload).toMatchObject({ sub: "ada@example.com", via: "sso" })
    expect(verifySessionToken(c, token, T0)).toEqual(payload)
  })

  it("keeps password sessions working alongside SSO", () => {
    const c = adminConfigFromEnv(env)
    const { token } = createSessionToken(c, T0)
    expect(verifySessionToken(c, token, T0)?.sub).toBe("root")
  })

  it("keeps SSO sessions working with password login switched off", () => {
    const c = adminConfigFromEnv({ ...env, MCPOCKET_PASSWORD_LOGIN: "false" })
    const { token } = createSsoSessionToken(c, "ada@example.com", T0)
    expect(verifySessionToken(c, token, T0)?.sub).toBe("ada@example.com")
    const pw = createSessionToken(adminConfigFromEnv(env), T0).token
    expect(verifySessionToken(c, pw, T0)).toBeNull()
  })

  it("works without an admin password (secret derived from the SSO secret)", () => {
    const c = adminConfigFromEnv({ MCPOCKET_SSO_SECRET: SECRET })
    expect(isSsoSessionConfigured(c)).toBe(true)
    const { token } = createSsoSessionToken(c, "ada@example.com", T0)
    expect(verifySessionToken(c, token, T0)?.sub).toBe("ada@example.com")
  })

  it("is refused when SSO is off, and invalidated when SSO is disabled or rotated", () => {
    const noSso = { ...env, MCPOCKET_SSO_SECRET: "" }
    expect(() =>
      createSsoSessionToken(adminConfigFromEnv(noSso), "a@b.c", T0)
    ).toThrow(/not configured/)
    const { token } = createSsoSessionToken(
      adminConfigFromEnv(env),
      "ada@example.com",
      T0
    )
    expect(verifySessionToken(adminConfigFromEnv(noSso), token, T0)).toBeNull()
    const rotated = adminConfigFromEnv({ ...env, MCPOCKET_SSO_SECRET: "new" })
    expect(verifySessionToken(rotated, token, T0)).toBeNull()
  })

  it("cannot be forged into an admin session by dropping `via`", () => {
    const c = adminConfigFromEnv(env)
    const { token } = createSsoSessionToken(c, "root", T0)
    // signature covers the payload: any edit breaks it
    const [v, body, sig] = token.split(".")
    const edited = b64({
      ...JSON.parse(Buffer.from(body, "base64url").toString()),
      via: undefined,
    })
    expect(verifySessionToken(c, `${v}.${edited}.${sig}`, T0)).toBeNull()
  })
})

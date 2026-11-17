import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { login } from "@/app/login/actions"
import { updateItemAction } from "@/app/dashboard/actions"
import { cookieJar, RedirectError } from "@/lib/auth/test-utils"
import {
  adminConfigFromEnv,
  SESSION_COOKIE,
  verifySessionToken,
} from "@mcpocket/core/auth/session"
import { resetSsoReplayCache, signSsoToken } from "@mcpocket/core/auth/sso"
import { getServices } from "@mcpocket/core/services"
import { resetStorageSingleton } from "@mcpocket/core/storage"

import { GET, POST } from "./route"

vi.mock("server-only", () => ({}))
vi.mock(
  "next/headers",
  async () => (await import("@/lib/auth/test-utils")).nextHeadersMock
)
vi.mock(
  "next/navigation",
  async () => (await import("@/lib/auth/test-utils")).nextNavigationMock
)
vi.mock(
  "next/cache",
  async () => (await import("@/lib/auth/test-utils")).nextCacheMock
)

const SSO_SECRET = "sso-secret-".repeat(4)
let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-sso-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_ADMIN_USERNAME", "boss")
  vi.stubEnv("MCPOCKET_ADMIN_PASSWORD", "pw-123456")
  vi.stubEnv("MCPOCKET_SESSION_SECRET", "s".repeat(40))
  vi.stubEnv("MCPOCKET_SSO_SECRET", SSO_SECRET)
  await resetStorageSingleton()
  resetSsoReplayCache()
  cookieJar.clear()
})
afterEach(async () => {
  await resetStorageSingleton()
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

let seq = 0
function mint(overrides: Record<string, unknown> = {}) {
  const iat = Math.floor(Date.now() / 1000)
  return signSsoToken(SSO_SECRET, {
    sub: "ada@example.com",
    jti: `test-${++seq}`,
    iat,
    exp: iat + 60,
    ...overrides,
  })
}

const get = (params: Record<string, string>) =>
  GET(
    new Request(
      `http://localhost/auth/sso?${new URLSearchParams(params).toString()}`
    )
  )

const sessionSub = () =>
  verifySessionToken(adminConfigFromEnv(), cookieJar.get(SESSION_COOKIE)?.value)
    ?.sub

describe("GET /auth/sso", () => {
  it("signs the person in with the same session cookie and redirects to /dashboard", async () => {
    const res = await get({ token: mint() })
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/dashboard")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
    const cookie = cookieJar.get(SESSION_COOKIE)
    expect(cookie?.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    })
    expect(sessionSub()).toBe("ada@example.com")
  })

  it("redirects to a safe `next` path only", async () => {
    const res = await get({ token: mint(), next: "/dashboard/agents" })
    expect(res.headers.get("location")).toBe("/dashboard/agents")
    const evil = await get({ token: mint(), next: "https://evil.example" })
    expect(evil.headers.get("location")).toBe("/dashboard")
  })

  it("rejects a replayed token without touching the session", async () => {
    const token = mint()
    expect((await get({ token })).headers.get("location")).toBe("/dashboard")
    cookieJar.clear()
    const replay = await get({ token })
    expect(replay.status).toBe(303)
    expect(replay.headers.get("location")).toBe(
      "/auth/sso/error?reason=replayed"
    )
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false)
  })

  it.each([
    [{}, "missing_token"],
    [{ token: "garbage" }, "malformed"],
    [{ token: "forged" }, "bad_signature"],
    [{ token: "expired" }, "expired"],
    [{ token: "wrong-ws" }, "workspace_mismatch"],
  ])(
    "sends invalid tokens (%j) to the error page with no session",
    async (params, reason) => {
      vi.stubEnv("MCPOCKET_SSO_WORKSPACE", "acme")
      const iat = Math.floor(Date.now() / 1000)
      const tokens: Record<string, string> = {
        garbage: "garbage",
        forged: signSsoToken("not-the-secret", {
          sub: "a@b.c",
          jti: "x",
          iat,
          exp: iat + 60,
          ws: "acme",
        }),
        expired: mint({ iat: iat - 120, exp: iat - 60, ws: "acme" }),
        "wrong-ws": mint({ ws: "other" }),
      }
      const token = (params as { token?: string }).token
      const res = await get(token ? { token: tokens[token] } : {})
      expect(res.headers.get("location")).toBe(
        `/auth/sso/error?reason=${reason}`
      )
      expect(cookieJar.has(SESSION_COOKIE)).toBe(false)
    }
  )

  it("is a 404 while MCPOCKET_SSO_SECRET is unset", async () => {
    vi.stubEnv("MCPOCKET_SSO_SECRET", "")
    const res = await get({ token: mint() })
    expect(res.status).toBe(404)
    const post = await POST(
      new Request("http://localhost/auth/sso", { method: "POST" })
    )
    expect(post.status).toBe(404)
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false)
  })
})

describe("POST /auth/sso", () => {
  it("accepts the token as a form field", async () => {
    const body = new URLSearchParams({
      token: mint({ sub: "bob@example.com" }),
      next: "/dashboard/mcp",
    })
    const res = await POST(
      new Request("http://localhost/auth/sso", { method: "POST", body })
    )
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/dashboard/mcp")
    expect(sessionSub()).toBe("bob@example.com")
  })
})

describe("after SSO login", () => {
  it("records dashboard actions as user:<email>", async () => {
    await get({ token: mint({ sub: "Ada@Example.com" }) })
    const system = await getServices({ kind: "system", id: "test" })
    const folder = await system.folders.create({ name: "F" })
    const tube = await system.tubes.create({ folderId: folder.id, name: "T" })
    const { item } = await system.items.push(tube.id, { payload: { n: 1 } })

    const result = await updateItemAction(item.id, { payload: { n: 2 } })
    expect(result.ok).toBe(true)
    const history = await system.items.history(item.id)
    expect(history.data.map((e) => [e.action, e.actor])).toEqual([
      ["updated", "user:ada@example.com"],
      ["created", "system:test"],
    ])
  })

  it("keeps password login working while SSO is enabled", async () => {
    const fd = new FormData()
    fd.set("username", "boss")
    fd.set("password", "pw-123456")
    await expect(login(undefined, fd)).rejects.toBeInstanceOf(RedirectError)
    expect(sessionSub()).toBe("boss")
  })
})

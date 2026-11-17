import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetRateLimiters } from "@mcpocket/core/api/rate-limit"
import { resetStorageSingleton } from "@mcpocket/core/storage"

import * as auditRoute from "../audit/route"
import * as foldersRoute from "../folders/route"
import * as mcpRoute from "../mcp/route"
import * as tubeRoute from "../tubes/[id]/route"
import * as tubesRoute from "../tubes/route"
import * as keyRoute from "./[id]/route"
import * as rotateRoute from "./[id]/rotate/route"
import * as keysRoute from "./route"

const ADMIN = "admin-secret"
const READONLY = "readonly-secret"
let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-keys-routes-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_API_KEYS", `ci:${ADMIN},viewer:${READONLY}`)
  vi.stubEnv("MCPOCKET_API_KEY_ROLES", "viewer:readonly")
  await resetStorageSingleton()
  resetRateLimiters()
})
afterEach(async () => {
  await resetStorageSingleton()
  resetRateLimiters()
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

const req = (
  url: string,
  init: RequestInit & { key?: string; agent?: string } = {}
) => {
  const { key = ADMIN, agent, ...rest } = init
  const headers = new Headers(rest.headers)
  headers.set("authorization", `Bearer ${key}`)
  if (agent) headers.set("x-agent-id", agent)
  if (rest.body) headers.set("content-type", "application/json")
  return new Request(`http://localhost${url}`, { ...rest, headers })
}
const json = (body: unknown) => JSON.stringify(body)
const params = <P>(p: P) => ({ params: Promise.resolve(p) })

async function setup() {
  const folder = async (name: string) =>
    (
      await (
        await foldersRoute.POST(
          req("/api/folders", { method: "POST", body: json({ name }) })
        )
      ).json()
    ).data
  const tube = async (folderId: string, name: string) =>
    (
      await (
        await tubesRoute.POST(
          req("/api/tubes", { method: "POST", body: json({ folderId, name }) })
        )
      ).json()
    ).data
  const a = await folder("A")
  const b = await folder("B")
  return { a, b, ta: await tube(a.id, "ta"), tb: await tube(b.id, "tb") }
}

const mcp = (method: string, params: unknown, key = ADMIN) =>
  mcpRoute.POST(
    req("/api/mcp", {
      key,
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
      body: json({ jsonrpc: "2.0", id: 1, method, params }),
    })
  )

describe("RBAC over REST", () => {
  it("keeps existing env keys working as admin; MCPOCKET_API_KEY_ROLES restricts", async () => {
    const created = await foldersRoute.POST(
      req("/api/folders", { method: "POST", body: json({ name: "x" }) })
    )
    expect(created.status).toBe(201)

    const listed = await foldersRoute.GET(
      req("/api/folders", { key: READONLY })
    )
    expect(listed.status).toBe(200)
    const denied = await foldersRoute.POST(
      req("/api/folders", {
        key: READONLY,
        method: "POST",
        body: json({ name: "y" }),
      })
    )
    expect(denied.status).toBe(403)
    expect((await denied.json()).error).toMatchObject({
      code: "forbidden",
      details: { capability: "structure:manage", role: "readonly" },
    })
    expect(
      (await keysRoute.GET(req("/api/keys", { key: READONLY }))).status
    ).toBe(403)
  })

  it("manages keys over REST and enforces the scope of a managed key", async () => {
    const { a, ta, tb } = await setup()
    const res = await keysRoute.POST(
      req("/api/keys", {
        method: "POST",
        body: json({
          id: "scoped",
          role: "operator",
          scope: { folderIds: [a.id] },
        }),
      })
    )
    expect(res.status).toBe(201)
    const { data: key, secret } = await res.json()
    expect(key).toMatchObject({ id: "scoped", role: "operator" })
    expect(secret).toMatch(/^mcp_/)

    const tubes = await (
      await tubesRoute.GET(req("/api/tubes", { key: secret }))
    ).json()
    expect(tubes.data.map((t: { id: string }) => t.id)).toEqual([ta.id])
    expect(tubes.page.total).toBe(1)
    expect(
      (
        await tubeRoute.GET(
          req(`/api/tubes/${tb.id}`, { key: secret }),
          params({ id: tb.id })
        )
      ).status
    ).toBe(404)
    expect(
      (await keysRoute.GET(req("/api/keys", { key: secret }))).status
    ).toBe(403)

    // permission change applies to the next request
    const patched = await keyRoute.PATCH(
      req("/api/keys/scoped", {
        method: "PATCH",
        body: json({ role: "readonly" }),
      }),
      params({ id: "scoped" })
    )
    expect(patched.status).toBe(200)
    const blocked = await tubesRoute.POST(
      req("/api/tubes", {
        key: secret,
        method: "POST",
        body: json({ folderId: a.id, name: "nope" }),
      })
    )
    expect(blocked.status).toBe(403)

    const rotated = await (
      await rotateRoute.POST(
        req("/api/keys/scoped/rotate", { method: "POST" }),
        params({ id: "scoped" })
      )
    ).json()
    expect(
      (await tubesRoute.GET(req("/api/tubes", { key: secret }))).status
    ).toBe(401)
    expect(
      (await tubesRoute.GET(req("/api/tubes", { key: rotated.secret }))).status
    ).toBe(200)

    const audit = await (
      await auditRoute.GET(req("/api/audit?targetId=scoped"))
    ).json()
    expect(audit.data.map((e: { action: string }) => e.action)).toEqual([
      "api_key.secret_rotated",
      "api_key.updated",
      "api_key.created",
    ])
    expect(audit.data[0].actor).toBe("api_key:ci")
  })
})

describe("RBAC over MCP (Streamable HTTP)", () => {
  it("lists only permitted tools and rejects forbidden calls", async () => {
    const names = async (key: string) =>
      (await (await mcp("tools/list", {}, key)).json()).result.tools.map(
        (t: { name: string }) => t.name
      )
    const adminTools = await names(ADMIN)
    expect(adminTools).toEqual(
      expect.arrayContaining([
        "create_folder",
        "claim_next_item",
        "reassign_item",
      ])
    )
    const roTools = await names(READONLY)
    expect(roTools).toEqual(
      expect.arrayContaining(["list_folders", "get_item", "get_statistics"])
    )
    for (const hidden of [
      "create_folder",
      "push_item",
      "claim_next_item",
      "reassign_item",
    ]) {
      expect(roTools).not.toContain(hidden)
    }

    const call = await (
      await mcp(
        "tools/call",
        { name: "create_folder", arguments: { name: "x" } },
        READONLY
      )
    ).json()
    expect(call.result.isError).toBe(true)
    expect(call.result.structuredContent.error.code).toBe("forbidden")
  })

  it("scopes MCP listings and lookups like REST", async () => {
    const { b, ta, tb } = await setup()
    const { secret } = await (
      await keysRoute.POST(
        req("/api/keys", {
          method: "POST",
          body: json({
            id: "mcp-scoped",
            role: "agent",
            scope: { tubeIds: [tb.id] },
          }),
        })
      )
    ).json()
    const tool = async (name: string, args: unknown) =>
      (
        await (
          await mcp("tools/call", { name, arguments: args }, secret)
        ).json()
      ).result.structuredContent
    const tubes = await tool("list_tubes", {})
    expect(tubes.data.map((t: { id: string }) => t.id)).toEqual([tb.id])
    const tree = await tool("get_folder_tree", {})
    expect(tree.data.map((f: { id: string }) => f.id)).toEqual([b.id])
    expect(
      (await tool("push_item", { tubeId: ta.id, payload: {} })).error.code
    ).toBe("not_found")
    expect(
      (await tool("push_item", { tubeId: tb.id, payload: {} })).created
    ).toBe(true)
    const resources = await (await mcp("resources/list", {}, secret)).json()
    expect(
      resources.result.resources
        .map((r: { uri: string }) => r.uri)
        .filter((u: string) => u.startsWith("mcpocket://tubes/"))
    ).toEqual([`mcpocket://tubes/${tb.id}`])
  })
})

describe("rate limiting", () => {
  it("returns 429 with RateLimit headers per key", async () => {
    vi.stubEnv("MCPOCKET_RATE_LIMIT_PER_MINUTE", "2")
    const first = await foldersRoute.GET(req("/api/folders"))
    expect(first.status).toBe(200)
    expect(first.headers.get("ratelimit-limit")).toBe("2")
    expect(first.headers.get("ratelimit-remaining")).toBe("1")
    expect(Number(first.headers.get("ratelimit-reset"))).toBeGreaterThan(0)
    expect((await foldersRoute.GET(req("/api/folders"))).status).toBe(200)

    const limited = await foldersRoute.GET(req("/api/folders"))
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/)
    expect(limited.headers.get("ratelimit-remaining")).toBe("0")
    expect((await limited.json()).error).toMatchObject({
      code: "rate_limited",
      details: { limit: 2 },
    })
    // agents share their key's budget; other keys are unaffected
    expect(
      (await foldersRoute.GET(req("/api/folders", { agent: "bot" }))).status
    ).toBe(429)
    expect((await mcp("tools/list", {})).status).toBe(429)
    expect(
      (await foldersRoute.GET(req("/api/folders", { key: READONLY }))).status
    ).toBe(200)
  })

  it("honours a managed key's own limit (0 = unlimited)", async () => {
    vi.stubEnv("MCPOCKET_RATE_LIMIT_PER_MINUTE", "1")
    const create = async (id: string, rateLimitPerMinute: number) =>
      (
        await (
          await keysRoute.POST(
            req("/api/keys", {
              method: "POST",
              body: json({ id, role: "readonly", rateLimitPerMinute }),
            })
          )
        ).json()
      ).secret as string
    resetRateLimiters()
    const three = await create("three", 3)
    resetRateLimiters()
    const unlimited = await create("free", 0)
    const statuses = async (key: string, n: number) => {
      const out: number[] = []
      for (let i = 0; i < n; i++) {
        out.push((await foldersRoute.GET(req("/api/folders", { key }))).status)
      }
      return out
    }
    expect(await statuses(three, 4)).toEqual([200, 200, 200, 429])
    const free = await foldersRoute.GET(req("/api/folders", { key: unlimited }))
    expect(free.headers.get("ratelimit-limit")).toBeNull()
    expect(await statuses(unlimited, 5)).toEqual([200, 200, 200, 200, 200])
  })
})

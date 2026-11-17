import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetStorageSingleton } from "@mcpocket/core/storage"

import * as foldersRoute from "../folders/route"
import * as tubeItemsRoute from "../tubes/[id]/items/route"
import * as tubesRoute from "../tubes/route"
import * as tubeBulkRoute from "../tubes/[id]/items/bulk/route"
import * as bulkRoute from "./bulk/route"

const SECRET = "test-secret-123"
let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-bulk-routes-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_API_KEYS", `ci:${SECRET}`)
  await resetStorageSingleton()
})
afterEach(async () => {
  await resetStorageSingleton()
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

const req = (
  url: string,
  init: RequestInit & { key?: string | null; agent?: string } = {}
) => {
  const { key = SECRET, agent, ...rest } = init
  const headers = new Headers(rest.headers)
  if (key) headers.set("authorization", `Bearer ${key}`)
  if (agent) headers.set("x-agent-id", agent)
  if (rest.body) headers.set("content-type", "application/json")
  return new Request(`http://localhost${url}`, { ...rest, headers })
}
const json = (method: string, body: unknown) => ({
  method,
  body: JSON.stringify(body),
})
const params = <P>(p: P) => ({ params: Promise.resolve(p) })

async function createTube(body: Record<string, unknown> = {}) {
  let res = await foldersRoute.POST(
    req("/api/folders", json("POST", { name: "F" }))
  )
  const folder = (await res.json()).data
  res = await tubesRoute.POST(
    req("/api/tubes", json("POST", { folderId: folder.id, name: "T", ...body }))
  )
  return (await res.json()).data as { id: string }
}

const bulkPush = (tubeId: string, body: unknown) =>
  tubeBulkRoute.POST(
    req(`/api/tubes/${tubeId}/items/bulk`, json("POST", body)),
    params({ id: tubeId })
  )
const list = (tubeId: string, query: string) =>
  tubeItemsRoute.GET(
    req(`/api/tubes/${tubeId}/items?${query}`),
    params({ id: tubeId })
  )

describe("search, filter & bulk REST routes", () => {
  it("bulk-pushes, filters via query params and bulk-updates", async () => {
    const tube = await createTube()
    let res = await bulkPush(tube.id, {
      items: [
        { payload: { city: "Berlin", n: 1 }, tags: ["a"], priority: 2 },
        { payload: { city: "Paris", n: 2 }, tags: ["a", "b"] },
        { payload: { city: "Berlin", n: 3 }, idempotencyKey: "k" },
        { payload: "nope" },
      ],
    })
    expect(res.status).toBe(200)
    const pushed = await res.json()
    expect(pushed.summary).toEqual({
      total: 4,
      succeeded: 3,
      failed: 1,
      created: 3,
    })
    expect(pushed.results[3]).toMatchObject({
      index: 3,
      ok: false,
      error: { code: "validation_error" },
    })

    res = await list(tube.id, "payload.city=Berlin&limit=1")
    expect(res.status).toBe(200)
    let body = await res.json()
    expect(body.page).toEqual({ offset: 0, limit: 1, total: 2 })
    expect(body.data[0].payload.n).toBe(1)

    body = await (await list(tube.id, "payload.n[gte]=2&tags=a")).json()
    expect(
      body.data.map((i: { payload: { n: number } }) => i.payload.n)
    ).toEqual([2])
    body = await (
      await list(tube.id, "payload.city[in]=Paris,Rome&status=pending")
    ).json()
    expect(body.page.total).toBe(1)
    body = await (await list(tube.id, "priorityMin=1")).json()
    expect(body.page.total).toBe(1)

    res = await list(tube.id, "status=bogus")
    expect(res.status).toBe(400)
    res = await list(tube.id, "payload.n[regex]=1")
    expect(res.status).toBe(400)

    const ids = pushed.results
      .filter((r: { ok: boolean }) => r.ok)
      .map((r: { data: { id: string } }) => r.data.id)
    res = await bulkRoute.PATCH(
      req(
        "/api/items/bulk",
        json("PATCH", { ids, patch: { status: "archived" } })
      )
    )
    expect(res.status).toBe(200)
    body = await res.json()
    expect(body.summary).toEqual({ total: 3, succeeded: 3, failed: 0 })
    body = await (await list(tube.id, "status=archived")).json()
    expect(body.page.total).toBe(3)

    res = await bulkRoute.PATCH(
      req(
        "/api/items/bulk",
        json("PATCH", { items: [{ id: ids[0], status: "pending" }] })
      )
    )
    body = await res.json()
    expect(body.results[0]).toMatchObject({
      ok: false,
      id: ids[0],
      error: { code: "conflict" },
    })
  })

  it("enforces size limits and auth", async () => {
    const tube = await createTube()
    let res = await bulkPush(tube.id, {
      items: Array.from({ length: 501 }, () => ({ payload: {} })),
    })
    expect(res.status).toBe(400)

    res = await bulkPush(tube.id, {
      items: [{ payload: { blob: "x".repeat(6 * 1024 * 1024) } }],
    })
    expect(res.status).toBe(413)
    expect((await res.json()).error.code).toBe("payload_too_large")

    res = await bulkRoute.PATCH(
      req("/api/items/bulk", { ...json("PATCH", {}), key: null })
    )
    expect(res.status).toBe(401)
    res = await bulkPush(crypto.randomUUID(), { items: [{ payload: {} }] })
    expect(res.status).toBe(404)
  })
})

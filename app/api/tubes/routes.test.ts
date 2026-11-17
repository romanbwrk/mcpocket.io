import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { getStorage, resetStorageSingleton } from "@mcpocket/core/storage"
import { makeItem } from "@mcpocket/core/storage/testing/contract"

import * as folderRoute from "../folders/[id]/route"
import * as foldersRoute from "../folders/route"
import * as treeRoute from "../folders/tree/route"
import * as resetRoute from "./[id]/reset/route"
import * as tubeRoute from "./[id]/route"
import * as tubesRoute from "./route"

const SECRET = "test-secret-123"
let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-tube-routes-"))
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

const req = (url: string, init: RequestInit & { key?: string | null } = {}) => {
  const { key = SECRET, ...rest } = init
  const headers = new Headers(rest.headers)
  if (key) headers.set("authorization", `Bearer ${key}`)
  if (rest.body) headers.set("content-type", "application/json")
  return new Request(`http://localhost${url}`, { ...rest, headers })
}
const json = (method: string, body: unknown) => ({
  method,
  body: JSON.stringify(body),
})
const params = <P>(p: P) => ({ params: Promise.resolve(p) })

async function createFolder(name: string) {
  const res = await foldersRoute.POST(
    req("/api/folders", json("POST", { name }))
  )
  return (await res.json()).data as { id: string }
}

describe("tube REST routes", () => {
  it("requires auth", async () => {
    const res = await tubesRoute.GET(req("/api/tubes", { key: null }))
    expect(res.status).toBe(401)
  })

  it("creates, lists by folder, configures, moves and deletes tubes", async () => {
    const a = await createFolder("A")
    const b = await createFolder("B")

    // folder must exist (404) and input must be valid (400)
    let res = await tubesRoute.POST(
      req(
        "/api/tubes",
        json("POST", { folderId: crypto.randomUUID(), name: "x" })
      )
    )
    expect(res.status).toBe(404)
    res = await tubesRoute.POST(
      req("/api/tubes", json("POST", { folderId: a.id }))
    )
    expect(res.status).toBe(400)
    res = await tubesRoute.POST(
      req(
        "/api/tubes",
        json("POST", {
          folderId: a.id,
          name: "x",
          schemaDefinition: { type: "nope" },
        })
      )
    )
    expect(res.status).toBe(400)
    const invalid = (await res.json()).error
    expect(invalid.code).toBe("validation_error")
    expect(invalid.details.length).toBeGreaterThan(0)

    res = await tubesRoute.POST(
      req(
        "/api/tubes",
        json("POST", {
          folderId: a.id,
          name: "Orders",
          schemaDefinition: { type: "object" },
        })
      )
    )
    expect(res.status).toBe(201)
    const tube = (await res.json()).data
    expect(tube).toMatchObject({
      name: "Orders",
      enabled: true,
      folderId: a.id,
    })
    await tubesRoute.POST(
      req("/api/tubes", json("POST", { folderId: b.id, name: "Other" }))
    )

    res = await tubesRoute.GET(req(`/api/tubes?folderId=${a.id}`))
    let body = await res.json()
    expect(body.data.map((t: { name: string }) => t.name)).toEqual(["Orders"])
    expect(body.page.total).toBe(1)
    res = await tubesRoute.GET(req("/api/tubes"))
    expect((await res.json()).page.total).toBe(2)

    // folder containing a tube cannot be deleted
    res = await folderRoute.DELETE(
      req(`/api/folders/${a.id}`, { method: "DELETE" }),
      params({ id: a.id })
    )
    expect(res.status).toBe(409)

    // configure + move
    res = await tubeRoute.PATCH(
      req(
        `/api/tubes/${tube.id}`,
        json("PATCH", { enabled: false, folderId: b.id })
      ),
      params({ id: tube.id })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({
      enabled: false,
      folderId: b.id,
    })
    res = await tubeRoute.PATCH(
      req(
        `/api/tubes/${tube.id}`,
        json("PATCH", { folderId: crypto.randomUUID() })
      ),
      params({ id: tube.id })
    )
    expect(res.status).toBe(404)

    // tree shows tubes as leaves
    res = await treeRoute.GET(req("/api/folders/tree"))
    body = await res.json()
    expect(body.data).toMatchObject([
      { name: "A", tubes: [] },
      { name: "B", tubes: [{ name: "Orders" }, { name: "Other" }] },
    ])

    // A is now empty
    res = await folderRoute.DELETE(
      req(`/api/folders/${a.id}`, { method: "DELETE" }),
      params({ id: a.id })
    )
    expect(res.status).toBe(204)

    // tube with items cannot be deleted
    const storage = await getStorage()
    const item = await storage.items.create(makeItem(tube.id))
    res = await tubeRoute.DELETE(
      req(`/api/tubes/${tube.id}`, { method: "DELETE" }),
      params({ id: tube.id })
    )
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("conflict")

    await storage.items.update(item.id, { deletedAt: new Date().toISOString() })
    res = await tubeRoute.DELETE(
      req(`/api/tubes/${tube.id}`, { method: "DELETE" }),
      params({ id: tube.id })
    )
    expect(res.status).toBe(204)
    res = await tubeRoute.GET(
      req(`/api/tubes/${tube.id}`),
      params({ id: tube.id })
    )
    expect(res.status).toBe(404)
  })

  it("resets a tube, optionally only some statuses", async () => {
    const res0 = await tubesRoute.POST(
      req("/api/tubes", json("POST", { name: "Reset me" }))
    )
    const tube = (await res0.json()).data as { id: string }
    const storage = await getStorage()
    const failed = await storage.items.create(
      makeItem(tube.id, { status: "failed", attempts: 2 })
    )
    const done = await storage.items.create(
      makeItem(tube.id, { status: "completed", attempts: 1 })
    )
    const reset = (body?: unknown) =>
      resetRoute.POST(
        req(
          `/api/tubes/${tube.id}/reset`,
          body === undefined ? { method: "POST" } : json("POST", body)
        ),
        params({ id: tube.id })
      )

    let res = await reset({ status: "nope" })
    expect(res.status).toBe(400)

    res = await reset({ status: "failed" })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      total: 2,
      matched: 1,
      requeued: 1,
    })
    expect((await storage.items.get(failed.id))?.status).toBe("pending")
    expect((await storage.items.get(done.id))?.status).toBe("completed")

    res = await reset()
    expect((await res.json()).data).toEqual({
      total: 2,
      matched: 2,
      requeued: 1,
    })
    expect((await storage.items.get(done.id))?.status).toBe("pending")
  })
})

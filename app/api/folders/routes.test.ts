import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetStorageSingleton } from "@mcpocket/core/storage"

import * as folderRoute from "./[id]/route"
import * as foldersRoute from "./route"
import * as treeRoute from "./tree/route"

const SECRET = "test-secret-123"
let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-routes-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_API_KEYS", `ci:${SECRET}, other:another-secret`)
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
const params = <P>(p: P) => ({ params: Promise.resolve(p) })

describe("folder REST routes", () => {
  describe("auth", () => {
    it.each([
      ["no key", null],
      ["wrong key", "nope"],
    ])("returns 401 with JSON error for %s", async (_, key) => {
      const res = await foldersRoute.GET(req("/api/folders", { key }))
      expect(res.status).toBe(401)
      expect(res.headers.get("www-authenticate")).toMatch(/Bearer/)
      const body = await res.json()
      expect(body).toEqual({
        error: { code: "unauthorized", message: expect.any(String) },
      })
      expect(JSON.stringify(body)).not.toContain(SECRET)
    })

    it("rejects everything when no keys are configured", async () => {
      vi.stubEnv("MCPOCKET_API_KEYS", "")
      const res = await treeRoute.GET(req("/api/folders/tree"))
      expect(res.status).toBe(401)
    })

    it("accepts the X-API-Key header", async () => {
      const res = await foldersRoute.GET(
        req("/api/folders", { key: null, headers: { "x-api-key": SECRET } })
      )
      expect(res.status).toBe(200)
    })
  })

  it("supports the folder lifecycle with mapped errors", async () => {
    let res = await foldersRoute.POST(
      req("/api/folders", {
        method: "POST",
        body: JSON.stringify({ name: "A" }),
      })
    )
    expect(res.status).toBe(201)
    const a = (await res.json()).data
    res = await foldersRoute.POST(
      req("/api/folders", {
        method: "POST",
        body: JSON.stringify({ name: "B", parentId: a.id }),
      })
    )
    const b = (await res.json()).data

    // 400: validation + malformed JSON
    res = await foldersRoute.POST(
      req("/api/folders", {
        method: "POST",
        body: JSON.stringify({ name: "" }),
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("validation_error")
    res = await foldersRoute.POST(
      req("/api/folders", { method: "POST", body: "{nope" })
    )
    expect(res.status).toBe(400)

    // 409: cycle and non-empty delete
    res = await folderRoute.PATCH(
      req(`/api/folders/${a.id}`, {
        method: "PATCH",
        body: JSON.stringify({ parentId: b.id }),
      }),
      params({ id: a.id })
    )
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("conflict")
    res = await folderRoute.DELETE(
      req(`/api/folders/${a.id}`, { method: "DELETE" }),
      params({ id: a.id })
    )
    expect(res.status).toBe(409)

    // list roots + tree
    res = await foldersRoute.GET(req("/api/folders?parentId=root"))
    expect(
      (await res.json()).data.map((f: { name: string }) => f.name)
    ).toEqual(["A"])
    res = await treeRoute.GET(req("/api/folders/tree"))
    const tree = (await res.json()).data
    expect(tree[0]).toMatchObject({ name: "A", children: [{ name: "B" }] })

    // delete leaf, then 404
    res = await folderRoute.DELETE(
      req(`/api/folders/${b.id}`, { method: "DELETE" }),
      params({ id: b.id })
    )
    expect(res.status).toBe(204)
    res = await folderRoute.GET(
      req(`/api/folders/${b.id}`),
      params({ id: b.id })
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe("not_found")
  })
})

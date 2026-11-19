import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createMemoryMediaStore } from "@mcpocket/core/media/store"
import {
  createServiceContext,
  createServices,
  type Services,
} from "@mcpocket/core/services"
import type { Storage } from "@mcpocket/core/storage"
import { createJsonStorage } from "@mcpocket/core/storage/json/json-storage"

vi.mock("server-only", () => ({}))
vi.mock(
  "next/headers",
  async () => (await import("@/lib/auth/test-utils")).nextHeadersMock
)

const { loadSharedItems, parseFeedQuery, shareAccess, shareHref } =
  await import("./server")

const SHA = "a".repeat(64)

describe("share helpers", () => {
  it("parses the feed query (newest first by default)", () => {
    expect(parseFeedQuery({})).toEqual({ status: undefined, order: "desc" })
    expect(parseFeedQuery({ status: "completed", order: "asc" })).toEqual({
      status: "completed",
      order: "asc",
    })
    expect(parseFeedQuery({ status: "nope" }).status).toBeUndefined()
  })

  it("keeps the key in share links", () => {
    expect(shareHref("/share/tubes/t1", "s e/cret", { status: "failed" })).toBe(
      "/share/tubes/t1?api_key=s+e%2Fcret&status=failed"
    )
  })

  it("refuses missing and unknown keys", async () => {
    expect(await shareAccess(undefined)).toEqual({
      ok: false,
      reason: "missing",
    })
    expect(await shareAccess("nope")).toEqual({
      ok: false,
      reason: "invalid",
    })
  })
})

describe("loadSharedItems", () => {
  let dataDir: string
  let storage: Storage
  let services: Services

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-share-"))
    storage = await createJsonStorage({ dataDir })
    const media = createMemoryMediaStore(
      {},
      "https://pocket.test/api/media/files"
    )
    services = createServices(createServiceContext(storage, { media }), {
      kind: "user",
      id: "admin",
    })
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it("lists newest first, finds media and signs own media links", async () => {
    const tube = await services.tubes.create({ name: "Videos" })
    const own = `https://pocket.test/api/media/files/media/aa/${SHA}.mp4`
    await services.items.push(tube.id, { payload: { prompt: "first" } })
    await services.items.push(tube.id, {
      payload: {
        prompt: "a cat",
        cover: "https://cdn.example/cover.jpg",
        page: "https://example.com/about",
      },
      metadata: { clip: own },
    })

    const page = await loadSharedItems(services, tube.id, { order: "desc" }, 0)
    expect(page.total).toBe(2)
    const [latest, oldest] = page.items
    expect(oldest.media).toEqual([])
    expect(latest.media.map((m) => [m.path, m.kind])).toEqual([
      ["payload.cover", "image"],
      ["metadata.clip", "video"],
    ])
    const clip = latest.media[1].url
    expect(clip).toMatch(/\?exp=\d+&sig=/)
    expect(latest.metadata.clip).toBe(clip)
    // External links are left as is.
    expect(latest.media[0].url).toBe("https://cdn.example/cover.jpg")
    expect((latest.payload as { page: string }).page).toBe(
      "https://example.com/about"
    )
  })

  it("filters by status", async () => {
    const tube = await services.tubes.create({ name: "T" })
    await services.items.push(tube.id, { payload: { n: 1 } })
    const page = await loadSharedItems(
      services,
      tube.id,
      { status: "completed", order: "desc" },
      0
    )
    expect(page).toEqual({ items: [], total: 0 })
  })
})

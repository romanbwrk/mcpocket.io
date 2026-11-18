import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ZodError } from "zod"

import { NotFoundError } from "../domain/errors"
import type { Tube } from "../domain/schemas"
import { createServiceContext, createServices, MAX_BULK_ITEMS } from "./index"
import type { Storage } from "../storage"
import * as files from "../storage/json/files"
import { createJsonStorage } from "../storage/json/json-storage"

vi.mock("../storage/json/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/json/files")>()
  return { ...actual, writeCollection: vi.fn(actual.writeCollection) }
})
const writeCollection = vi.mocked(files.writeCollection)

let dataDir: string
let storage: Storage
let services: ReturnType<typeof createServices>
let tube: Tube
let tick = 0

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-bulk-"))
  storage = await createJsonStorage({ dataDir })
  tick = 0
  // One second per clock read → createdAt grows with each push.
  const clock = { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) }
  services = createServices(createServiceContext(storage, { clock }), {
    kind: "api_key",
    id: "ci",
  })
  const folder = await services.folders.create({ name: "f" })
  tube = await services.tubes.create({
    folderId: folder.id,
    name: "t",
    schemaDefinition: {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    },
  })
  writeCollection.mockClear()
})
afterEach(async () => {
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

const persistedCollections = () =>
  writeCollection.mock.calls.map(([, name]) => name).sort()

describe("search & filtering", () => {
  beforeEach(async () => {
    for (let n = 0; n < 10; n++) {
      await services.items.push(tube.id, {
        payload: { n, customer: { tier: n % 2 ? "gold" : "silver" } },
        priority: n % 3,
        tags: n < 5 ? ["early"] : ["late", n % 2 ? "odd" : "even"],
      })
    }
  })

  it("combines filters with pagination; total counts all matches", async () => {
    const page1 = await services.items.list(tube.id, {
      payload: [{ path: "customer.tier", value: "gold" }],
      limit: 2,
    })
    expect(page1.page).toEqual({ offset: 0, limit: 2, total: 5 })
    expect(page1.data.map((i) => i.payload.n)).toEqual([1, 3])
    const page2 = await services.items.list(tube.id, {
      payload: [{ path: "customer.tier", value: "gold" }],
      offset: 4,
      limit: 2,
    })
    expect(page2.data.map((i) => i.payload.n)).toEqual([9])

    const combined = await services.items.list(tube.id, {
      tags: "late,odd",
      priorityMin: 1,
      payload: [{ path: "n", op: "lt", value: 9 }],
    })
    expect(combined.data.map((i) => i.payload.n)).toEqual([5, 7])
  })

  it("filters by status, agent, created range and priority", async () => {
    const all = (await services.items.list(tube.id)).data
    await services.items.update(all[0].id, { status: "cancelled" })
    expect(
      (await services.items.list(tube.id, { status: "cancelled" })).data
    ).toHaveLength(1)
    expect(
      (await services.items.list(tube.id, { assignedAgent: "nobody" })).page
        .total
    ).toBe(0)
    const range = await services.items.list(tube.id, {
      createdFrom: all[2].createdAt,
      createdTo: all[4].createdAt,
    })
    expect(range.data.map((i) => i.payload.n)).toEqual([2, 3, 4])
    expect(
      (await services.items.list(tube.id, { priority: 2 })).data.map(
        (i) => i.payload.n
      )
    ).toEqual([2, 5, 8])
  })

  it("search works across tubes or within one, and validates filters", async () => {
    const other = await services.tubes.create({
      folderId: tube.folderId,
      name: "other",
    })
    await services.items.push(other.id, { payload: { n: 1 } })
    expect(
      (await services.items.search({ payload: [{ path: "n", value: 1 }] })).page
        .total
    ).toBe(2)
    expect(
      (
        await services.items.search({
          tubeId: other.id,
          payload: [{ path: "n", value: 1 }],
        })
      ).data[0].tubeId
    ).toBe(other.id)
    await expect(
      services.items.search({ tubeId: crypto.randomUUID() })
    ).rejects.toThrow(NotFoundError)
    await expect(
      services.items.list(tube.id, { status: "bogus" })
    ).rejects.toThrow(ZodError)
  })
})

describe("bulk push", () => {
  it("pushes many items with per-item results, persisting once", async () => {
    const result = await services.items.bulkPush(tube.id, {
      items: [
        { payload: { n: 1 }, idempotencyKey: "k1" },
        { payload: { n: "x" } }, // schema violation
        { payload: { n: 2 }, idempotencyKey: "k1" }, // replay within batch
        { nope: true }, // input validation
        { payload: { n: 3 }, tags: ["x"] },
      ],
    })
    expect(result.summary).toEqual({
      total: 5,
      succeeded: 3,
      failed: 2,
      created: 2,
    })
    const [r0, r1, r2, r3, r4] = result.results
    expect(r0).toMatchObject({ index: 0, ok: true, created: true })
    expect(r1).toMatchObject({
      index: 1,
      ok: false,
      error: { code: "validation_error" },
    })
    expect(r2).toMatchObject({ index: 2, ok: true, created: false })
    if (r0.ok && r2.ok) expect(r2.data.id).toBe(r0.data.id)
    expect(r3).toMatchObject({ ok: false, error: { code: "validation_error" } })
    expect(r4).toMatchObject({ ok: true, created: true })

    // One transaction: items + history written exactly once each.
    expect(persistedCollections()).toEqual(["history", "items"])
    expect((await services.items.list(tube.id)).page.total).toBe(2)
    if (r4.ok) {
      expect((await services.items.history(r4.data.id)).data).toHaveLength(1)
    }

    // Replaying an earlier key in a later bulk returns the original item.
    const again = await services.items.bulkPush(tube.id, {
      items: [{ payload: { n: 9 }, idempotencyKey: "k1" }],
    })
    expect(again.summary.created).toBe(0)
  })

  it("enforces the size limit and tube checks", async () => {
    const tooMany = Array.from({ length: MAX_BULK_ITEMS + 1 }, (_, n) => ({
      payload: { n },
    }))
    await expect(
      services.items.bulkPush(tube.id, { items: tooMany })
    ).rejects.toThrow(ZodError)
    await expect(
      services.items.bulkPush(tube.id, { items: [] })
    ).rejects.toThrow(ZodError)
    await expect(
      services.items.bulkPush(crypto.randomUUID(), { items: [{ payload: {} }] })
    ).rejects.toThrow(NotFoundError)
    expect(writeCollection).not.toHaveBeenCalled()

    const max = await services.items.bulkPush(tube.id, {
      items: tooMany.slice(0, MAX_BULK_ITEMS),
    })
    expect(max.summary.created).toBe(MAX_BULK_ITEMS)
    expect(persistedCollections()).toEqual(["history", "items"])

    await services.tubes.update(tube.id, { enabled: false })
    const disabled = await services.items.bulkPush(tube.id, {
      items: [{ payload: { n: 1 } }],
    })
    expect(disabled.results[0]).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    })
  })

  it("rolls back everything on an unexpected error", async () => {
    writeCollection.mockRejectedValueOnce(new Error("disk full"))
    await expect(
      services.items.bulkPush(tube.id, {
        items: [{ payload: { n: 1 } }, { payload: { n: 2 } }],
      })
    ).rejects.toThrow("disk full")
    expect((await services.items.list(tube.id)).page.total).toBe(0)
  })

  it("restores files only after every write of the failed commit settled", async () => {
    // Regression (flaky "rolls back" test): with Promise.all the commit
    // rolled back as soon as one write failed, while a slower sibling write
    // was still running — it then overwrote the restored file (and could
    // race the temp-dir cleanup).
    const actual = writeCollection.getMockImplementation()!
    writeCollection
      .mockRejectedValueOnce(new Error("disk full")) // items.json
      .mockImplementationOnce(async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return actual(...args) // history.json, slow
      })
    await expect(
      services.items.bulkPush(tube.id, { items: [{ payload: { n: 1 } }] })
    ).rejects.toThrow("disk full")
    // give a (wrongly) still-running write time to land
    await new Promise((resolve) => setTimeout(resolve, 60))
    const history = JSON.parse(
      await readFile(path.join(dataDir, "history.json"), "utf8")
    )
    expect(history).toEqual([])
  })
})

describe("bulk update", () => {
  async function seed(count: number) {
    const { results } = await services.items.bulkPush(tube.id, {
      items: Array.from({ length: count }, (_, n) => ({ payload: { n } })),
    })
    writeCollection.mockClear()
    return results.map((r) => (r.ok ? r.data.id : ""))
  }

  it("applies one patch to many ids with single-update rules and history", async () => {
    const ids = await seed(3)
    await services.items.delete(ids[2])
    writeCollection.mockClear()

    const result = await services.items.bulkUpdate({
      ids: [ids[0], ids[1], ids[2], crypto.randomUUID()],
      patch: { status: "cancelled" },
    })
    expect(result.summary).toEqual({ total: 4, succeeded: 2, failed: 2 })
    expect(result.results[2]).toMatchObject({
      ok: false,
      id: ids[2],
      error: { code: "conflict" },
    })
    expect(result.results[3]).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    })
    expect(persistedCollections()).toEqual(["history", "items"])

    for (const id of ids.slice(0, 2)) {
      const history = await services.items.history(id)
      expect(history.data.map((e) => e.action)).toEqual([
        "status_changed",
        "created",
      ])
      expect(history.data[0]).toMatchObject({
        actor: "api_key:ci",
        oldValue: { status: "pending" },
        newValue: { status: "cancelled" },
      })
    }

    // Same rules as PATCH: processing is claim-only.
    const invalid = await services.items.bulkUpdate({
      ids: [ids[0]],
      patch: { status: "processing" },
    })
    expect(invalid.results[0]).toMatchObject({
      ok: false,
      error: {
        code: "validation_error",
        details: { status: "processing" },
      },
    })
    // cancelled → pending is an allowed manual transition.
    const processing = await services.items.bulkUpdate({
      ids: [ids[1]],
      patch: { status: "pending" },
    })
    expect(processing.results[0].ok).toBe(true)
  })

  it("applies per-item changes and validates each entry", async () => {
    const ids = await seed(3)
    const result = await services.items.bulkUpdate({
      items: [
        { id: ids[0], priority: 7, tags: ["hot"] },
        { id: ids[1], payload: { n: "bad" } }, // tube schema
        { id: ids[2], bogus: 1 }, // strict input
        { id: "not-a-uuid", priority: 1 },
      ],
    })
    expect(result.results.map((r) => r.ok)).toEqual([true, false, false, false])
    expect(result.results.slice(1).map((r) => !r.ok && r.error.code)).toEqual([
      "validation_error",
      "validation_error",
      "validation_error",
    ])
    const history = await services.items.history(ids[0])
    expect(history.data[0]).toMatchObject({
      action: "updated",
      oldValue: { priority: 0, tags: [] },
      newValue: { priority: 7, tags: ["hot"] },
    })
    expect(history.page.total).toBe(2)
    expect((await services.items.history(ids[1])).page.total).toBe(1)
  })

  it("rejects malformed and oversized requests", async () => {
    await expect(services.items.bulkUpdate({})).rejects.toThrow(ZodError)
    await expect(
      services.items.bulkUpdate({ ids: [crypto.randomUUID()] })
    ).rejects.toThrow(ZodError)
    await expect(
      services.items.bulkUpdate({
        items: [{ id: crypto.randomUUID(), priority: 1 }],
        ids: [crypto.randomUUID()],
        patch: { priority: 1 },
      })
    ).rejects.toThrow(ZodError)
    await expect(
      services.items.bulkUpdate({
        ids: Array.from({ length: MAX_BULK_ITEMS + 1 }, () =>
          crypto.randomUUID()
        ),
        patch: { priority: 1 },
      })
    ).rejects.toThrow(ZodError)
    expect(writeCollection).not.toHaveBeenCalled()
  })
})

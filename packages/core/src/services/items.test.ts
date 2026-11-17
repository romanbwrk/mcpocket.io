import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ZodError } from "zod"

import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../domain/errors"
import {
  canTransitionManually,
  ITEM_STATUS_TRANSITIONS,
} from "../domain/item-status"
import type { Tube } from "../domain/schemas"
import { createServiceContext, createServices } from "./index"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

let dataDir: string
let storage: Storage
let services: ReturnType<typeof createServices>
let tube: Tube
let tick = 0

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-items-"))
  storage = await createJsonStorage({ dataDir })
  tick = 0
  const clock = { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) }
  services = createServices(createServiceContext(storage, { clock }), {
    kind: "agent",
    id: "bot-1",
  })
  const folder = await services.folders.create({ name: "f" })
  tube = await services.tubes.create({ folderId: folder.id, name: "t" })
})
afterEach(async () => {
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

const PERSON = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "integer" } },
  required: ["name"],
}

describe("item service", () => {
  it("pushes with defaults and records a created event", async () => {
    const { item, created } = await services.items.push(tube.id, {
      payload: { a: 1 },
    })
    expect(created).toBe(true)
    expect(item).toMatchObject({
      tubeId: tube.id,
      status: "pending",
      payload: { a: 1 },
      priority: 0,
      tags: [],
      metadata: {},
      attempts: 0,
      assignedAgent: null,
      leaseExpiresAt: null,
    })
    const history = await services.items.history(item.id)
    expect(history.data).toHaveLength(1)
    expect(history.data[0]).toMatchObject({
      action: "created",
      actor: "agent:bot-1",
      newValue: item,
    })
  })

  it("validates input and rejects pushes to missing or disabled tubes", async () => {
    await expect(services.items.push(tube.id, {})).rejects.toThrow(ZodError)
    await expect(
      services.items.push(tube.id, { payload: [1] })
    ).rejects.toThrow(ZodError)
    await expect(
      services.items.push(tube.id, { payload: {}, priority: 1.5 })
    ).rejects.toThrow(ZodError)
    await expect(
      services.items.push(crypto.randomUUID(), { payload: {} })
    ).rejects.toThrow(NotFoundError)
    await services.tubes.update(tube.id, { enabled: false })
    await expect(services.items.push(tube.id, { payload: {} })).rejects.toThrow(
      ConflictError
    )
  })

  it("validates payloads against the tube schema on push and update", async () => {
    await services.tubes.update(tube.id, { schemaDefinition: PERSON })
    const err = await services.items
      .push(tube.id, { payload: { age: "x" } })
      .catch((e) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "required", path: "payload" }),
        expect.objectContaining({ keyword: "type", path: "payload/age" }),
      ])
    )
    const { item } = await services.items.push(tube.id, {
      payload: { name: "Ann" },
    })
    await expect(
      services.items.update(item.id, { payload: { name: 3 } })
    ).rejects.toThrow(ValidationError)
    // metadata changes are not schema-checked
    await services.items.update(item.id, { metadata: { any: true } })
  })

  it("dedupes pushes by idempotency key per tube, also concurrently", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        services.items.push(tube.id, {
          payload: { n: i },
          idempotencyKey: "k1",
        })
      )
    )
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(new Set(results.map((r) => r.item.id)).size).toBe(1)
    expect((await services.items.list(tube.id)).page.total).toBe(1)

    // same key in another tube is independent
    const other = await services.tubes.create({
      folderId: tube.folderId,
      name: "other",
    })
    const r = await services.items.push(other.id, {
      payload: {},
      idempotencyKey: "k1",
    })
    expect(r.created).toBe(true)
  })

  it("updates fields and status with history, rejecting invalid transitions", async () => {
    const { item } = await services.items.push(tube.id, {
      payload: { a: 1 },
      tags: ["x"],
    })
    const updated = await services.items.update(item.id, {
      payload: { a: 2 },
      tags: ["x"], // unchanged → not in the diff
      priority: 5,
      status: "cancelled",
    })
    expect(updated).toMatchObject({
      payload: { a: 2 },
      priority: 5,
      status: "cancelled",
    })
    expect(updated.updatedAt > item.updatedAt).toBe(true)

    const history = (await services.items.history(item.id)).data
    expect(history.map((e) => e.action)).toEqual([
      "status_changed",
      "updated",
      "created",
    ])
    expect(history[0]).toMatchObject({
      oldValue: { status: "pending" },
      newValue: { status: "cancelled" },
      actor: "agent:bot-1",
    })
    expect(history[1]).toMatchObject({
      oldValue: { payload: { a: 1 }, priority: 0 },
      newValue: { payload: { a: 2 }, priority: 5 },
    })

    // processing only via claim; archived is terminal
    await expect(
      services.items.update(item.id, { status: "processing" })
    ).rejects.toThrow(ConflictError)
    await services.items.update(item.id, { status: "archived" })
    await expect(
      services.items.update(item.id, { status: "pending" })
    ).rejects.toThrow(ConflictError)

    // no-op update writes nothing
    const before = (await services.items.history(item.id)).page.total
    await services.items.update(item.id, { priority: 5 })
    expect((await services.items.history(item.id)).page.total).toBe(before)

    await expect(services.items.update(item.id, {})).rejects.toThrow(ZodError)
    await expect(
      services.items.update(item.id, { status: "bogus" })
    ).rejects.toThrow(ZodError)
    await expect(
      services.items.update(crypto.randomUUID(), { priority: 1 })
    ).rejects.toThrow(NotFoundError)
  })

  it("transition table: processing is claim-only, completed sets completedAt", async () => {
    expect(canTransitionManually("pending", "processing")).toBe(false)
    expect(canTransitionManually("processing", "completed")).toBe(true)
    expect(ITEM_STATUS_TRANSITIONS.archived).toEqual([])

    const { item } = await services.items.push(tube.id, { payload: {} })
    await storage.items.update(item.id, {
      status: "processing",
      assignedAgent: "bot-2",
      leaseExpiresAt: new Date().toISOString(),
    })
    const done = await services.items.update(item.id, { status: "completed" })
    expect(done.completedAt).toBeTruthy()
    expect(done.assignedAgent).toBeNull()
    expect(done.leaseExpiresAt).toBeNull()
  })

  it("soft deletes: hidden from lists, still readable with history", async () => {
    const a = (await services.items.push(tube.id, { payload: { n: 1 } })).item
    const b = (await services.items.push(tube.id, { payload: { n: 2 } })).item
    const deleted = await services.items.delete(a.id)
    expect(deleted.deletedAt).toBeTruthy()

    const list = await services.items.list(tube.id)
    expect(list.data.map((i) => i.id)).toEqual([b.id])
    expect(list.page.total).toBe(1)
    const all = await services.items.list(tube.id, { includeDeleted: "true" })
    expect(all.data.map((i) => i.id)).toEqual([a.id, b.id])

    expect((await services.items.get(a.id)).deletedAt).toBe(deleted.deletedAt)
    const history = (await services.items.history(a.id)).data
    expect(history[0]).toMatchObject({
      action: "deleted",
      newValue: { deletedAt: deleted.deletedAt },
    })
    await expect(services.items.delete(a.id)).rejects.toThrow(ConflictError)
    await expect(services.items.update(a.id, { priority: 1 })).rejects.toThrow(
      ConflictError
    )
  })

  it("lists with stable createdAt ordering and offset pagination", async () => {
    const ids: string[] = []
    for (let i = 0; i < 7; i++) {
      ids.push((await services.items.push(tube.id, { payload: { i } })).item.id)
    }
    const pages = []
    for (let offset = 0; offset < 7; offset += 3) {
      pages.push(await services.items.list(tube.id, { offset, limit: 3 }))
    }
    expect(pages.flatMap((p) => p.data.map((i) => i.id))).toEqual(ids)
    expect(pages[0].page).toEqual({ offset: 0, limit: 3, total: 7 })
    await expect(services.items.list(crypto.randomUUID())).rejects.toThrow(
      NotFoundError
    )
  })

  it("rolls back the item write when the history write fails", async () => {
    const { item } = await services.items.push(tube.id, { payload: {} })
    const original = storage.history.append.bind(storage.history)
    storage.history.append = async () => {
      throw new Error("boom")
    }
    try {
      await expect(
        services.items.update(item.id, { priority: 9 })
      ).rejects.toThrow("boom")
    } finally {
      storage.history.append = original
    }
    expect((await services.items.get(item.id)).priority).toBe(0)
  })
  it("reassigns the agent with a history event; the new agent owns the lease", async () => {
    const { item } = await services.items.push(tube.id, { payload: {} })
    const clock = services.ctx.clock
    const admin = createServices(createServiceContext(storage, { clock }), {
      kind: "user",
      id: "admin",
    })
    const assigned = await admin.items.reassign(item.id, { agentId: "bot-9" })
    expect(assigned.assignedAgent).toBe("bot-9")
    expect((await admin.items.history(item.id)).data[0]).toMatchObject({
      action: "reassigned",
      actor: "user:admin",
      oldValue: { assignedAgent: null },
      newValue: { assignedAgent: "bot-9" },
    })
    // same agent → no-op
    await admin.items.reassign(item.id, { agentId: "bot-9" })
    expect((await admin.items.history(item.id)).page.total).toBe(2)
    await expect(admin.items.reassign(item.id, {})).rejects.toThrow(ZodError)
    await admin.items.reassign(item.id, { agentId: null })

    // processing: lease moves to bot-2, who can complete; bot-1 no longer can
    const claimed = await services.processing.claim({ tubeId: tube.id })
    expect(claimed?.item.id).toBe(item.id)
    await expect(
      admin.items.reassign(item.id, { agentId: null })
    ).rejects.toThrow(ConflictError)
    const moved = await admin.items.reassign(item.id, { agentId: "bot-2" })
    expect(moved.leaseExpiresAt).toBe(claimed?.item.leaseExpiresAt)
    await expect(services.processing.complete(item.id, {})).rejects.toThrow()
    const bot2 = createServices(createServiceContext(storage, { clock }), {
      kind: "agent",
      id: "bot-2",
    })
    expect((await bot2.processing.complete(item.id, {})).status).toBe(
      "completed"
    )

    await admin.items.delete(item.id)
    await expect(
      admin.items.reassign(item.id, { agentId: "bot-3" })
    ).rejects.toThrow(ConflictError)
  })

  it("retry / cancel from processing end the lease", async () => {
    for (const status of ["retry", "cancelled"] as const) {
      const { item } = await services.items.push(tube.id, { payload: {} })
      await services.processing.claim({ tubeId: tube.id })
      const updated = await services.items.update(item.id, { status })
      expect(updated).toMatchObject({
        status,
        assignedAgent: null,
        leaseExpiresAt: null,
      })
    }
  })
})

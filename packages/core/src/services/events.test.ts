import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Actor } from "../domain/actor"
import { EventBus, getEventBus } from "../events/bus"
import {
  matchesEventScope,
  parseEventScope,
  type DomainEvent,
} from "../events/types"
import {
  createServiceContext,
  createServices,
  transact,
  type ServiceContext,
} from "./index"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

let dataDir: string
let storage: Storage
let ctx: ServiceContext
let bus: EventBus
let events: DomainEvent[]

const admin: Actor = { kind: "user", id: "admin" }
const agent: Actor = { kind: "agent", id: "bot-1" }
const svc = (actor: Actor = admin) => createServices(ctx, actor)
const types = () => events.map((e) => e.type)

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-events-"))
  storage = await createJsonStorage({ dataDir })
  bus = new EventBus()
  ctx = createServiceContext(storage, { events: bus, leaseSeconds: 60 })
  events = []
  bus.subscribe((e) => events.push(e))
})
afterEach(async () => {
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

async function setup() {
  const folder = await svc().folders.create({ name: "f" })
  const tube = await svc().tubes.create({ folderId: folder.id, name: "t" })
  events.length = 0
  return { folder, tube }
}

describe("event bus", () => {
  it("stamps increasing seq, isolates throwing listeners, unsubscribes", () => {
    const b = new EventBus()
    const seen: number[] = []
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    b.subscribe(() => {
      throw new Error("boom")
    })
    const off = b.subscribe((e) => seen.push(e.seq))
    expect(b.listenerCount).toBe(2)
    const input = {
      type: "folder.created" as const,
      at: "2026-01-01T00:00:00.000Z",
      actor: "user:a",
      folderId: "x",
      parentId: null,
    }
    b.publish(input)
    b.publish(input)
    off()
    off()
    b.publish(input)
    expect(seen).toEqual([1, 2])
    expect(b.listenerCount).toBe(1)
    expect(b.lastSeq).toBe(3)
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })

  it("default context uses the process-wide bus", () => {
    expect(createServiceContext(storage).events).toBe(getEventBus())
    expect(getEventBus()).toBe(getEventBus())
  })
})

describe("services publish domain events after commit", () => {
  it("folder and tube writes", async () => {
    const folder = await svc().folders.create({ name: "a" })
    await svc().folders.update(folder.id, { name: "b" })
    const tube = await svc().tubes.create({ folderId: folder.id, name: "t" })
    await svc().tubes.update(tube.id, { enabled: false })
    await svc().tubes.delete(tube.id)
    await svc().folders.delete(folder.id)
    expect(types()).toEqual([
      "folder.created",
      "folder.updated",
      "tube.created",
      "tube.updated",
      "tube.deleted",
      "folder.deleted",
    ])
    expect(events[2]).toMatchObject({
      tubeId: tube.id,
      folderId: folder.id,
      actor: "user:admin",
    })
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it("item lifecycle via items + processing services", async () => {
    const { tube } = await setup()
    const { item } = await svc().items.push(tube.id, { payload: { n: 1 } })
    await svc().items.update(item.id, { tags: ["x"] })
    const claimed = await svc(agent).processing.claim({ tubeId: tube.id })
    await svc(agent).processing.heartbeat(claimed!.item.id)
    await svc(agent).processing.complete(item.id, { result: { ok: true } })
    await svc().items.update(item.id, { status: "archived" })
    await svc().items.delete(item.id)

    expect(
      events.map((e) =>
        e.type === "item.created" || e.type.startsWith("item.")
          ? [e.type, "action" in e ? e.action : null]
          : null
      )
    ).toEqual([
      ["item.created", "created"],
      ["item.updated", "updated"],
      ["item.status_changed", "claimed"],
      ["item.updated", "heartbeat"],
      ["item.status_changed", "completed"],
      ["item.status_changed", "status_changed"],
      ["item.deleted", "deleted"],
    ])
    expect(events[2]).toMatchObject({
      itemId: item.id,
      tubeId: tube.id,
      status: "processing",
      previousStatus: "pending",
      assignedAgent: "bot-1",
      actor: "agent:bot-1",
    })
  })

  it("publishes nothing for failed or no-op writes", async () => {
    const { tube } = await setup()
    const { item } = await svc().items.push(tube.id, { payload: {} })
    events.length = 0
    await expect(
      svc().items.update(item.id, { status: "completed" })
    ).rejects.toThrow() // pending → completed is not a manual transition
    await svc().items.update(item.id, { priority: item.priority }) // no-op
    await svc().items.push(tube.id, { payload: {}, idempotencyKey: "k" })
    await svc().items.push(tube.id, { payload: {}, idempotencyKey: "k" }) // replay
    expect(types()).toEqual(["item.created"])
  })

  it("defers events until the outermost transaction commits; rollback drops them", async () => {
    const { tube } = await setup()
    let seenInside = -1
    await expect(
      transact(ctx, async () => {
        await svc().items.push(tube.id, { payload: {} })
        seenInside = events.length
        throw new Error("abort")
      })
    ).rejects.toThrow("abort")
    expect(seenInside).toBe(0)
    expect(events).toEqual([])
    expect((await svc().items.list(tube.id)).page.total).toBe(0)

    await transact(ctx, async () => {
      await svc().items.push(tube.id, { payload: {} })
      await svc().items.push(tube.id, { payload: {} })
      expect(events).toEqual([])
    })
    expect(types()).toEqual(["item.created", "item.created"])
  })

  it("bulk ops publish one event per successful entry", async () => {
    const { tube } = await setup()
    const res = await svc().items.bulkPush(tube.id, {
      items: [
        { payload: { n: 1 } },
        { payload: {}, priority: "bad" },
        { payload: { n: 3 } },
      ],
    })
    expect(res.summary).toMatchObject({ succeeded: 2, failed: 1 })
    expect(types()).toEqual(["item.created", "item.created"])
    events.length = 0
    const ids = res.results.flatMap((r) => (r.ok ? [r.data.id] : []))
    await svc().items.bulkUpdate({ ids, patch: { status: "cancelled" } })
    expect(types()).toEqual(["item.status_changed", "item.status_changed"])
  })
})

describe("event scopes", () => {
  it("parses query params and matches events", async () => {
    const id = "00000000-0000-4000-8000-000000000001"
    expect(parseEventScope(new URLSearchParams())).toEqual({ kind: "global" })
    expect(parseEventScope(new URLSearchParams({ tubeId: id }))).toEqual({
      kind: "tube",
      tubeId: id,
    })
    expect(parseEventScope(new URLSearchParams({ itemId: id }))).toEqual({
      kind: "item",
      itemId: id,
    })
    expect(parseEventScope(new URLSearchParams({ tubeId: "nope" }))).toBeNull()

    const { tube, folder } = await setup()
    const { item } = await svc().items.push(tube.id, { payload: {} })
    await svc().folders.update(folder.id, { name: "renamed" })
    const [itemEv, folderEv] = events
    const other = "00000000-0000-4000-8000-000000000002"
    expect(matchesEventScope(itemEv, { kind: "tube", tubeId: tube.id })).toBe(
      true
    )
    expect(matchesEventScope(itemEv, { kind: "tube", tubeId: other })).toBe(
      false
    )
    expect(matchesEventScope(itemEv, { kind: "item", itemId: item.id })).toBe(
      true
    )
    expect(matchesEventScope(itemEv, { kind: "item", itemId: other })).toBe(
      false
    )
    // structural events reach every scope (explorer tree)
    expect(matchesEventScope(folderEv, { kind: "item", itemId: other })).toBe(
      true
    )
  })
})

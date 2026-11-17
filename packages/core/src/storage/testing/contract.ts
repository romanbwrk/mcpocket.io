import { randomUUID } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type {
  ApiKeyRecord,
  AuditEvent,
  Folder,
  HistoryEvent,
  Item,
  Tube,
  Webhook,
  WebhookDelivery,
} from "../../domain/schemas"
import { DuplicateIdError } from "../errors"
import type { Storage } from "../types"

/**
 * Repository contract test suite. Written only against the `Storage`
 * interface so every adapter (JSON now, Mongo later) runs the same checks:
 *
 *   runStorageContract("json", { create: () => createJsonStorage(...) });
 */
export type ContractHarness = {
  /** Returns a fresh, empty storage instance. */
  create: () => Promise<Storage>
  /** Optional cleanup after each test (temp dirs, DB drop, ...). */
  cleanup?: () => Promise<void>
}

const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()

export const makeFolder = (overrides: Partial<Folder> = {}): Folder => ({
  id: randomUUID(),
  parentId: null,
  name: "Folder",
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
})

export const makeTube = (
  folderId: string,
  overrides: Partial<Tube> = {}
): Tube => ({
  id: randomUUID(),
  folderId,
  name: "Tube",
  enabled: true,
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
})

export const makeItem = (
  tubeId: string,
  overrides: Partial<Item> = {}
): Item => ({
  id: randomUUID(),
  tubeId,
  status: "pending",
  payload: {},
  metadata: {},
  tags: [],
  priority: 0,
  assignedAgent: null,
  leaseExpiresAt: null,
  attempts: 0,
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
})

export const makeEvent = (
  itemId: string,
  overrides: Partial<HistoryEvent> = {}
): HistoryEvent => ({
  id: randomUUID(),
  itemId,
  action: "created",
  actor: "test",
  createdAt: at(0),
  ...overrides,
})

export const makeApiKey = (
  overrides: Partial<ApiKeyRecord> = {}
): ApiKeyRecord => ({
  id: `key-${randomUUID().slice(0, 8)}`,
  role: "readonly",
  scope: null,
  secretHash: "0".repeat(64),
  secretPrefix: "mcp_0000",
  createdBy: "test",
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
})

export const makeAuditEvent = (
  overrides: Partial<AuditEvent> = {}
): AuditEvent => ({
  id: randomUUID(),
  action: "api_key.created",
  targetType: "api_key",
  targetId: "k",
  actor: "test",
  createdAt: at(0),
  ...overrides,
})

export const makeWebhook = (overrides: Partial<Webhook> = {}): Webhook => ({
  id: randomUUID(),
  name: "hook",
  url: "https://example.com/hook",
  eventTypes: [],
  folderId: null,
  tubeId: null,
  enabled: true,
  secret: "whsec_0123456789abcdef",
  createdBy: "test",
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
})

export const makeDelivery = (
  webhookId: string,
  overrides: Partial<WebhookDelivery> = {}
): WebhookDelivery => ({
  id: randomUUID(),
  webhookId,
  eventId: randomUUID(),
  eventType: "item.created",
  payload: { id: "e" },
  status: "pending",
  attempts: 0,
  nextAttemptAt: at(0),
  attemptLog: [],
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
})

export function runStorageContract(
  name: string,
  harness: ContractHarness
): void {
  describe(`Storage contract: ${name}`, () => {
    let storage: Storage

    beforeEach(async () => {
      storage = await harness.create()
    })

    afterEach(async () => {
      await storage.close()
      await harness.cleanup?.()
    })

    describe("folders", () => {
      it("creates, reads, updates and deletes", async () => {
        const folder = makeFolder({ name: "Sales", description: "pipeline" })
        expect(await storage.folders.create(folder)).toEqual(folder)
        expect(await storage.folders.get(folder.id)).toEqual(folder)

        const updated = await storage.folders.update(folder.id, {
          name: "Sales EU",
          updatedAt: at(5),
        })
        expect(updated).toEqual({
          ...folder,
          name: "Sales EU",
          updatedAt: at(5),
        })
        expect(await storage.folders.get(folder.id)).toEqual(updated)

        expect(await storage.folders.delete(folder.id)).toBe(true)
        expect(await storage.folders.get(folder.id)).toBeNull()
        expect(await storage.folders.delete(folder.id)).toBe(false)
      })

      it("returns null when updating a missing id", async () => {
        expect(
          await storage.folders.update(randomUUID(), { name: "x" })
        ).toBeNull()
      })

      it("rejects duplicate ids", async () => {
        const folder = makeFolder()
        await storage.folders.create(folder)
        await expect(storage.folders.create(folder)).rejects.toBeInstanceOf(
          DuplicateIdError
        )
      })

      it("rejects invalid entities", async () => {
        await expect(
          storage.folders.create(makeFolder({ name: "" }))
        ).rejects.toThrow()
        await expect(
          storage.folders.create(makeFolder({ id: "not-a-uuid" }))
        ).rejects.toThrow()
      })

      it("removes optional fields patched with undefined and keeps id/createdAt immutable", async () => {
        const folder = await storage.folders.create(
          makeFolder({ description: "d" })
        )
        const updated = await storage.folders.update(folder.id, {
          description: undefined,
          ...({ id: randomUUID(), createdAt: at(9) } as object),
        })
        expect(updated).not.toHaveProperty("description")
        expect(updated?.id).toBe(folder.id)
        expect(updated?.createdAt).toBe(folder.createdAt)
      })

      it("filters by parentId (null = roots) and orders by createdAt", async () => {
        const rootB = await storage.folders.create(
          makeFolder({ name: "B", createdAt: at(2) })
        )
        const rootA = await storage.folders.create(
          makeFolder({ name: "A", createdAt: at(1) })
        )
        const child = await storage.folders.create(
          makeFolder({ name: "child", parentId: rootA.id, createdAt: at(0) })
        )

        expect((await storage.folders.list()).map((f) => f.id)).toEqual([
          child.id,
          rootA.id,
          rootB.id,
        ])
        expect(
          (await storage.folders.list({ parentId: null })).map((f) => f.id)
        ).toEqual([rootA.id, rootB.id])
        expect(await storage.folders.list({ parentId: rootA.id })).toEqual([
          child,
        ])
        expect(await storage.folders.count({ parentId: null })).toBe(2)
      })

      it("returns copies that cannot mutate stored state", async () => {
        const folder = await storage.folders.create(
          makeFolder({ name: "orig" })
        )
        folder.name = "mutated"
        const read = await storage.folders.get(folder.id)
        read!.name = "mutated"
        ;(await storage.folders.list())[0].name = "mutated"
        expect((await storage.folders.get(folder.id))?.name).toBe("orig")
      })
    })

    describe("tubes", () => {
      it("supports CRUD and filtering by folder", async () => {
        const f1 = await storage.folders.create(makeFolder())
        const f2 = await storage.folders.create(makeFolder())
        const t1 = await storage.tubes.create(
          makeTube(f1.id, {
            schemaDefinition: { type: "object" },
            createdAt: at(1),
          })
        )
        const t2 = await storage.tubes.create(
          makeTube(f2.id, { createdAt: at(2) })
        )

        expect(await storage.tubes.get(t1.id)).toEqual(t1)
        expect(await storage.tubes.list({ folderId: f1.id })).toEqual([t1])
        expect((await storage.tubes.list()).map((t) => t.id)).toEqual([
          t1.id,
          t2.id,
        ])

        const moved = await storage.tubes.update(t2.id, {
          folderId: f1.id,
          enabled: false,
        })
        expect(moved).toMatchObject({ folderId: f1.id, enabled: false })
        expect(await storage.tubes.count({ folderId: f1.id })).toBe(2)

        expect(await storage.tubes.delete(t1.id)).toBe(true)
        expect(await storage.tubes.list({ folderId: f1.id })).toEqual([moved])
      })
    })

    describe("items", () => {
      const tubeId = randomUUID()

      it("supports CRUD", async () => {
        const item = makeItem(tubeId, {
          payload: { a: { b: [1, 2] } },
          tags: ["x"],
        })
        expect(await storage.items.create(item)).toEqual(item)
        const updated = await storage.items.update(item.id, {
          status: "completed",
          result: { ok: true },
          completedAt: at(3),
        })
        expect(updated).toEqual({
          ...item,
          status: "completed",
          result: { ok: true },
          completedAt: at(3),
        })
        expect(await storage.items.delete(item.id)).toBe(true)
        expect(await storage.items.get(item.id)).toBeNull()
      })

      it("rejects invalid status", async () => {
        const item = await storage.items.create(makeItem(tubeId))
        await expect(
          storage.items.update(item.id, { status: "bogus" as Item["status"] })
        ).rejects.toThrow()
        expect((await storage.items.get(item.id))?.status).toBe("pending")
      })

      it("orders by createdAt then insertion order, and paginates stably", async () => {
        const c = await storage.items.create(
          makeItem(tubeId, { createdAt: at(3) })
        )
        const a1 = await storage.items.create(
          makeItem(tubeId, { createdAt: at(1) })
        )
        const a2 = await storage.items.create(
          makeItem(tubeId, { createdAt: at(1) })
        )
        const b = await storage.items.create(
          makeItem(tubeId, { createdAt: at(2) })
        )
        const order = [a1.id, a2.id, b.id, c.id]

        expect((await storage.items.list({ tubeId })).map((i) => i.id)).toEqual(
          order
        )
        const page1 = await storage.items.list({ tubeId, offset: 0, limit: 2 })
        const page2 = await storage.items.list({ tubeId, offset: 2, limit: 2 })
        const page3 = await storage.items.list({ tubeId, offset: 4, limit: 2 })
        expect([...page1, ...page2].map((i) => i.id)).toEqual(order)
        expect(page3).toEqual([])

        // Updating an item does not change its position.
        await storage.items.update(a1.id, { priority: 9, updatedAt: at(10) })
        expect((await storage.items.list({ tubeId })).map((i) => i.id)).toEqual(
          order
        )
      })

      it("filters by tube, status, agent and hides soft-deleted items by default", async () => {
        const otherTube = randomUUID()
        const pending = await storage.items.create(makeItem(tubeId))
        const processing = await storage.items.create(
          makeItem(tubeId, { status: "processing", assignedAgent: "agent-1" })
        )
        const retry = await storage.items.create(
          makeItem(tubeId, { status: "retry" })
        )
        const deleted = await storage.items.create(
          makeItem(tubeId, { deletedAt: at(5) })
        )
        await storage.items.create(makeItem(otherTube))

        expect((await storage.items.list({ tubeId })).map((i) => i.id)).toEqual(
          [pending.id, processing.id, retry.id]
        )
        expect(
          (await storage.items.list({ tubeId, includeDeleted: true })).map(
            (i) => i.id
          )
        ).toContain(deleted.id)
        expect(
          (
            await storage.items.list({ tubeId, status: ["pending", "retry"] })
          ).map((i) => i.id)
        ).toEqual([pending.id, retry.id])
        expect(await storage.items.list({ status: "processing" })).toEqual([
          processing,
        ])
        expect(await storage.items.list({ assignedAgent: "agent-1" })).toEqual([
          processing,
        ])
        expect(await storage.items.count({ tubeId })).toBe(3)
        expect(await storage.items.count()).toBe(4)
      })

      it("finds items by idempotency key per tube", async () => {
        const item = await storage.items.create(
          makeItem(tubeId, { idempotencyKey: "k1" })
        )
        expect(await storage.items.findByIdempotencyKey(tubeId, "k1")).toEqual(
          item
        )
        expect(
          await storage.items.findByIdempotencyKey(randomUUID(), "k1")
        ).toBeNull()
        expect(
          await storage.items.findByIdempotencyKey(tubeId, "k2")
        ).toBeNull()
      })
    })

    describe("history", () => {
      it("appends and lists newest first, ties last-appended first", async () => {
        const itemId = randomUUID()
        const e1 = await storage.history.append(
          makeEvent(itemId, { createdAt: at(1) })
        )
        const e3 = await storage.history.append(
          makeEvent(itemId, { createdAt: at(3) })
        )
        const e2a = await storage.history.append(
          makeEvent(itemId, {
            action: "updated",
            createdAt: at(2),
            oldValue: 1,
            newValue: 2,
          })
        )
        const e2b = await storage.history.append(
          makeEvent(itemId, { action: "status_changed", createdAt: at(2) })
        )
        await storage.history.append(
          makeEvent(randomUUID(), { actor: "agent-7" })
        )

        expect(
          (await storage.history.list({ itemId })).map((e) => e.id)
        ).toEqual([e3.id, e2b.id, e2a.id, e1.id])
        expect(
          await storage.history.list({ itemId, offset: 1, limit: 1 })
        ).toEqual([e2b])
        expect(await storage.history.count({ itemId })).toBe(4)
        expect((await storage.history.list({ actor: "agent-7" })).length).toBe(
          1
        )
      })

      it("rejects duplicate event ids", async () => {
        const event = makeEvent(randomUUID())
        await storage.history.append(event)
        await expect(storage.history.append(event)).rejects.toBeInstanceOf(
          DuplicateIdError
        )
      })
    })

    describe("apiKeys", () => {
      it("supports CRUD, ordering and rejects duplicates / invalid records", async () => {
        const k1 = await storage.apiKeys.create(
          makeApiKey({ id: "k1", createdAt: at(2) })
        )
        const k2 = await storage.apiKeys.create(
          makeApiKey({ id: "k2", createdAt: at(1) })
        )
        expect((await storage.apiKeys.list()).map((k) => k.id)).toEqual([
          "k2",
          "k1",
        ])
        expect(await storage.apiKeys.count()).toBe(2)
        await expect(
          storage.apiKeys.create(makeApiKey({ id: "k1" }))
        ).rejects.toBeInstanceOf(DuplicateIdError)
        await expect(
          storage.apiKeys.create(makeApiKey({ secretHash: "plain-secret" }))
        ).rejects.toThrow()
        const updated = await storage.apiKeys.update(k1.id, {
          role: "operator",
          scope: { folderIds: [randomUUID()], tubeIds: [] },
        })
        expect(updated?.role).toBe("operator")
        expect(await storage.apiKeys.get(k1.id)).toEqual(updated)
        expect(await storage.apiKeys.delete(k2.id)).toBe(true)
        expect(await storage.apiKeys.get(k2.id)).toBeNull()
      })
    })

    describe("audit", () => {
      it("appends and lists newest first with target filters", async () => {
        const e1 = await storage.audit.append(
          makeAuditEvent({ createdAt: at(1) })
        )
        const e2 = await storage.audit.append(
          makeAuditEvent({ action: "api_key.updated", createdAt: at(2) })
        )
        await storage.audit.append(makeAuditEvent({ targetId: "other" }))
        expect(
          (await storage.audit.list({ targetId: "k" })).map((e) => e.id)
        ).toEqual([e2.id, e1.id])
        expect(await storage.audit.count({ targetType: "api_key" })).toBe(3)
        await expect(storage.audit.append(e1)).rejects.toBeInstanceOf(
          DuplicateIdError
        )
      })
    })

    describe("webhooks", () => {
      it("CRUD, ordered by createdAt", async () => {
        const w2 = await storage.webhooks.create(
          makeWebhook({ createdAt: at(2) })
        )
        const w1 = await storage.webhooks.create(
          makeWebhook({ createdAt: at(1) })
        )
        expect((await storage.webhooks.list()).map((w) => w.id)).toEqual([
          w1.id,
          w2.id,
        ])
        expect(await storage.webhooks.count()).toBe(2)
        await expect(storage.webhooks.create(w1)).rejects.toBeInstanceOf(
          DuplicateIdError
        )
        await expect(
          storage.webhooks.create(makeWebhook({ url: "ftp://nope" }))
        ).rejects.toThrow()
        expect(
          await storage.webhooks.update(w1.id, { enabled: false })
        ).toMatchObject({ enabled: false })
        expect(await storage.webhooks.delete(w2.id)).toBe(true)
        expect(await storage.webhooks.get(w2.id)).toBeNull()
      })
    })

    describe("webhookDeliveries", () => {
      it("filters by webhook, status and due time; newest first on request", async () => {
        const a = randomUUID()
        const b = randomUUID()
        const d1 = await storage.webhookDeliveries.create(
          makeDelivery(a, { createdAt: at(1), nextAttemptAt: at(5) })
        )
        const d2 = await storage.webhookDeliveries.create(
          makeDelivery(a, { createdAt: at(2), nextAttemptAt: at(1) })
        )
        const d3 = await storage.webhookDeliveries.create(
          makeDelivery(b, {
            createdAt: at(3),
            status: "delivered",
            nextAttemptAt: null,
          })
        )
        const ids = (list: WebhookDelivery[]) => list.map((d) => d.id)
        expect(ids(await storage.webhookDeliveries.list())).toEqual([
          d1.id,
          d2.id,
          d3.id,
        ])
        expect(
          ids(await storage.webhookDeliveries.list({ newestFirst: true }))
        ).toEqual([d3.id, d2.id, d1.id])
        expect(
          ids(await storage.webhookDeliveries.list({ webhookId: a, limit: 1 }))
        ).toEqual([d1.id])
        expect(
          ids(
            await storage.webhookDeliveries.list({
              status: "pending",
              dueBefore: at(2),
            })
          )
        ).toEqual([d2.id])
        expect(
          await storage.webhookDeliveries.count({
            status: ["pending", "delivered"],
          })
        ).toBe(3)
        expect(await storage.webhookDeliveries.count({ webhookId: b })).toBe(1)
      })
    })

    describe("transactions and concurrency", () => {
      it("does not lose concurrent writes", async () => {
        const tubeId = randomUUID()
        const items = Array.from({ length: 50 }, () => makeItem(tubeId))
        await Promise.all(items.map((item) => storage.items.create(item)))
        expect(await storage.items.count({ tubeId })).toBe(50)
      })

      it("serialises read-modify-write transactions (no lost updates)", async () => {
        const item = await storage.items.create(makeItem(randomUUID()))
        await Promise.all(
          Array.from({ length: 25 }, () =>
            storage.transaction(async (tx) => {
              const current = await tx.items.get(item.id)
              await new Promise((resolve) => setTimeout(resolve, 1))
              await tx.items.update(item.id, {
                attempts: current!.attempts + 1,
              })
            })
          )
        )
        expect((await storage.items.get(item.id))?.attempts).toBe(25)
      })

      it("commits all writes of a transaction together", async () => {
        const item = makeItem(randomUUID())
        const result = await storage.transaction(async (tx) => {
          await tx.items.create(item)
          await tx.history.append(makeEvent(item.id))
          // Reads inside the transaction see its own writes.
          return tx.items.get(item.id)
        })
        expect(result).toEqual(item)
        expect(await storage.history.count({ itemId: item.id })).toBe(1)
      })

      it("rolls back every write when the transaction throws", async () => {
        const existing = await storage.items.create(makeItem(randomUUID()))
        const fresh = makeItem(randomUUID())
        await expect(
          storage.transaction(async (tx) => {
            await tx.items.create(fresh)
            await tx.items.update(existing.id, { status: "processing" })
            await tx.history.append(makeEvent(fresh.id))
            throw new Error("boom")
          })
        ).rejects.toThrow("boom")

        expect(await storage.items.get(fresh.id)).toBeNull()
        expect((await storage.items.get(existing.id))?.status).toBe("pending")
        expect(await storage.history.count()).toBe(0)
      })

      it("does not expose uncommitted writes to readers outside the transaction", async () => {
        const item = makeItem(randomUUID())
        let release!: () => void
        const gate = new Promise<void>((resolve) => (release = resolve))
        let created!: () => void
        const wasCreated = new Promise<void>((resolve) => (created = resolve))

        const tx = storage.transaction(async (repos) => {
          await repos.items.create(item)
          created()
          await gate
        })
        await wasCreated
        expect(await storage.items.get(item.id)).toBeNull()
        release()
        await tx
        expect(await storage.items.get(item.id)).toEqual(item)
      })

      it("lets nested transactions and storage-level repos join the active transaction", async () => {
        const item = makeItem(randomUUID())
        await storage.transaction(async () => {
          await storage.transaction(async (inner) => {
            await inner.items.create(item)
          })
          await storage.history.append(makeEvent(item.id))
        })
        expect(await storage.items.get(item.id)).toEqual(item)
        expect(await storage.history.count({ itemId: item.id })).toBe(1)
      })

      it("never hands the same item to two concurrent claimers", async () => {
        const tubeId = randomUUID()
        for (let i = 0; i < 10; i++) {
          await storage.items.create(makeItem(tubeId, { priority: i % 3 }))
        }
        const claim = (agent: string) =>
          storage.transaction(async (tx) => {
            const [next] = (
              await tx.items.list({ tubeId, status: "pending" })
            ).sort((a, b) => b.priority - a.priority)
            if (!next) return null
            await new Promise((resolve) => setTimeout(resolve, 0))
            return tx.items.update(next.id, {
              status: "processing",
              assignedAgent: agent,
            })
          })
        const claimed = await Promise.all(
          Array.from({ length: 15 }, (_, i) => claim(`a${i}`))
        )
        const ids = claimed.filter((c) => c !== null).map((c) => c!.id)
        expect(ids).toHaveLength(10)
        expect(new Set(ids).size).toBe(10)
      })
    })
  })
}

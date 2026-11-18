import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ZodError } from "zod"

import type { Actor } from "../domain/actor"
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../domain/errors"
import type { Tube } from "../domain/schemas"
import {
  createServiceContext,
  createServices,
  leaseSecondsFromEnv,
  type ServiceContext,
} from "./index"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

let dataDir: string
let storage: Storage
let ctx: ServiceContext
let nowMs: number
let tube: Tube

const T0 = Date.UTC(2026, 0, 1)
const agent = (id: string): Actor => ({ kind: "agent", id })
const as = (id: string) => createServices(ctx, agent(id))
const advance = (seconds: number) => {
  nowMs += seconds * 1000
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-processing-"))
  storage = await createJsonStorage({ dataDir })
  nowMs = T0
  // Clock advances 1 ms per read so createdAt is strictly ordered.
  ctx = createServiceContext(storage, {
    clock: { now: () => new Date(nowMs++) },
    leaseSeconds: 60,
  })
  const admin = createServices(ctx, { kind: "api_key", id: "ci" })
  const folder = await admin.folders.create({ name: "f" })
  tube = await admin.tubes.create({ folderId: folder.id, name: "t" })
})
afterEach(async () => {
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

const push = async (priority = 0, payload: Record<string, unknown> = {}) =>
  (await as("producer").items.push(tube.id, { payload, priority })).item

describe("processing service: claim", () => {
  it("claims highest priority, then oldest, and sets the lease", async () => {
    const low = await push(0, { n: "low" })
    const highOld = await push(5, { n: "high-old" })
    const highNew = await push(5, { n: "high-new" })
    const bot = as("bot-1")

    const first = await bot.processing.claim({ tubeId: tube.id })
    expect(first?.item.id).toBe(highOld.id)
    expect(first?.claim).toEqual({
      itemId: highOld.id,
      agentId: "bot-1",
      claimedAt: expect.any(String),
      leaseExpiresAt: new Date(
        Date.parse(first!.claim.claimedAt) + 60_000
      ).toISOString(),
      attempts: 1,
    })
    expect(first?.item).toMatchObject({
      status: "processing",
      assignedAgent: "bot-1",
      leaseExpiresAt: first?.claim.leaseExpiresAt,
      attempts: 1,
    })
    expect((await bot.processing.claim({ tubeId: tube.id }))?.item.id).toBe(
      highNew.id
    )
    expect((await bot.processing.claim({ tubeId: tube.id }))?.item.id).toBe(
      low.id
    )
    expect(await bot.processing.claim({ tubeId: tube.id })).toBeNull()

    const history = await bot.items.history(highOld.id)
    expect(history.data[0]).toMatchObject({
      action: "claimed",
      actor: "agent:bot-1",
      oldValue: { status: "pending", assignedAgent: null, attempts: 0 },
      newValue: { status: "processing", assignedAgent: "bot-1", attempts: 1 },
    })
  })

  it("claims retry items and honours a leaseSeconds override", async () => {
    const item = await push()
    await as("x").items.update(item.id, { status: "cancelled" })
    expect(await as("bot").processing.claim({ tubeId: tube.id })).toBeNull()
    const ctxItem = await storage.items.update(item.id, { status: "retry" })
    expect(ctxItem?.status).toBe("retry")
    const res = await as("bot").processing.claim({
      tubeId: tube.id,
      leaseSeconds: 10,
    })
    expect(res?.item.id).toBe(item.id)
    expect(
      Date.parse(res!.claim.leaseExpiresAt!) - Date.parse(res!.claim.claimedAt)
    ).toBe(10_000)
  })

  it("skips deleted items and live leases; reclaims expired leases", async () => {
    const deleted = await push(9)
    await as("x").items.delete(deleted.id)
    const item = await push()
    const a = await as("bot-a").processing.claim({ tubeId: tube.id })
    expect(a?.item.id).toBe(item.id)
    expect(await as("bot-b").processing.claim({ tubeId: tube.id })).toBeNull()

    advance(61)
    const b = await as("bot-b").processing.claim({ tubeId: tube.id })
    expect(b?.item).toMatchObject({
      id: item.id,
      assignedAgent: "bot-b",
      attempts: 2,
    })
    const history = await as("x").items.history(item.id)
    expect(history.data[0]).toMatchObject({
      action: "claimed",
      actor: "agent:bot-b",
      oldValue: { status: "retry", assignedAgent: "bot-a", attempts: 1 },
    })
    // claim recovered the expired lease first (same rules as the sweeper)
    expect(history.data[1]).toMatchObject({
      action: "lease_expired",
      actor: "system:lease-sweeper",
      oldValue: { status: "processing", assignedAgent: "bot-a" },
      newValue: { status: "retry", error: { code: "lease_expired" } },
    })

    // The previous owner lost the lease.
    await expect(as("bot-a").processing.complete(item.id)).rejects.toThrow(
      ForbiddenError
    )
  })

  it("validates input, agent identity and tube state", async () => {
    const services = as("bot")
    await expect(services.processing.claim({})).rejects.toThrow(ZodError)
    await expect(
      services.processing.claim({ tubeId: tube.id, leaseSeconds: -1 })
    ).rejects.toThrow(ZodError)
    await expect(
      services.processing.claim({ tubeId: crypto.randomUUID() })
    ).rejects.toThrow(NotFoundError)
    await expect(
      createServices(ctx, { kind: "api_key", id: "ci" }).processing.claim({
        tubeId: tube.id,
      })
    ).rejects.toThrow(ValidationError)
    await as("x").tubes.update(tube.id, { enabled: false })
    await expect(
      services.processing.claim({ tubeId: tube.id })
    ).rejects.toThrow(ConflictError)
  })
})

describe("processing service: lease owner operations", () => {
  async function claimed(agentId = "bot-1") {
    await push()
    const res = await as(agentId).processing.claim({ tubeId: tube.id })
    return res!.item
  }

  it("complete stores result and completedAt", async () => {
    const item = await claimed()
    const done = await as("bot-1").processing.complete(item.id, {
      result: { summary: "ok" },
    })
    expect(done).toMatchObject({
      status: "completed",
      result: { summary: "ok" },
      completedAt: expect.any(String),
      leaseExpiresAt: null,
      assignedAgent: "bot-1",
    })
    const [event] = (await as("x").items.history(item.id)).data
    expect(event).toMatchObject({
      action: "completed",
      actor: "agent:bot-1",
      oldValue: { status: "processing" },
      newValue: { status: "completed", result: { summary: "ok" } },
    })
  })

  it("fail stores error info", async () => {
    await as("x").tubes.update(tube.id, { retryPolicy: { maxAttempts: 1 } })
    const item = await claimed()
    const failed = await as("bot-1").processing.fail(item.id, {
      error: { message: "boom", code: "E_TIMEOUT", details: { s: 30 } },
    })
    expect(failed).toMatchObject({
      status: "failed",
      leaseExpiresAt: null,
      lastError: {
        message: "boom",
        code: "E_TIMEOUT",
        details: { s: 30 },
        attempt: 1,
        agentId: "bot-1",
      },
    })
    expect((await as("x").items.history(item.id)).data[0]).toMatchObject({
      action: "failed",
      actor: "agent:bot-1",
      newValue: { status: "failed", error: { message: "boom" } },
    })

    const other = await claimed()
    expect(
      (await as("bot-1").processing.fail(other.id, { error: "plain" }))
        .lastError
    ).toMatchObject({ message: "plain" })
    await expect(as("bot-1").processing.fail(item.id, {})).rejects.toThrow(
      ZodError
    )
  })

  it("release returns the item to pending and it can be claimed again", async () => {
    const item = await claimed()
    const released = await as("bot-1").processing.release(item.id, {
      reason: "shutting down",
    })
    expect(released).toMatchObject({
      status: "pending",
      assignedAgent: null,
      leaseExpiresAt: null,
      attempts: 1,
    })
    expect((await as("x").items.history(item.id)).data[0]).toMatchObject({
      action: "released",
      actor: "agent:bot-1",
      newValue: { status: "pending", reason: "shutting down" },
    })
    const again = await as("bot-2").processing.claim({ tubeId: tube.id })
    expect(again?.item).toMatchObject({ id: item.id, attempts: 2 })
  })

  it("heartbeat extends the lease", async () => {
    const item = await claimed()
    advance(50)
    const hb = await as("bot-1").processing.heartbeat(item.id)
    expect(Date.parse(hb.leaseExpiresAt!)).toBe(nowMs - 1 + 60_000)
    advance(50) // past the original lease, within the renewed one
    const hb2 = await as("bot-1").processing.heartbeat(item.id, {
      leaseSeconds: 120,
    })
    expect(Date.parse(hb2.leaseExpiresAt!)).toBe(nowMs - 1 + 120_000)
    expect(await as("bot-2").processing.claim({ tubeId: tube.id })).toBeNull()
    expect((await as("x").items.history(item.id)).data[0]).toMatchObject({
      action: "heartbeat",
      actor: "agent:bot-1",
      newValue: { leaseExpiresAt: hb2.leaseExpiresAt },
    })
  })

  it("only the lease owner may act: 403 for others, 409 when expired or not processing", async () => {
    const item = await claimed("bot-1")
    const other = as("bot-2").processing
    await expect(other.complete(item.id)).rejects.toThrow(ForbiddenError)
    await expect(other.fail(item.id, { error: "x" })).rejects.toThrow(
      ForbiddenError
    )
    await expect(other.release(item.id)).rejects.toThrow(ForbiddenError)
    await expect(other.heartbeat(item.id)).rejects.toThrow(ForbiddenError)

    advance(61)
    const owner = as("bot-1").processing
    await expect(owner.heartbeat(item.id)).rejects.toThrow(ConflictError)
    await expect(owner.complete(item.id)).rejects.toThrow(ConflictError)

    const pending = await push()
    await expect(owner.complete(pending.id)).rejects.toThrow(ConflictError)
    await expect(owner.complete(crypto.randomUUID())).rejects.toThrow(
      NotFoundError
    )
    await expect(
      createServices(ctx, { kind: "api_key", id: "ci" }).processing.complete(
        item.id
      )
    ).rejects.toThrow(ValidationError)
  })

  it("lists an agent's items with a status filter", async () => {
    const a = await claimed("bot-1")
    const b = await claimed("bot-1")
    await claimed("bot-2")
    await as("bot-1").processing.complete(a.id)
    const all = await as("x").processing.agentItems("bot-1")
    expect(all.data.map((i) => i.id)).toEqual([a.id, b.id])
    expect(all.page.total).toBe(2)
    const processing = await as("x").processing.agentItems("bot-1", {
      status: "processing",
    })
    expect(processing.data.map((i) => i.id)).toEqual([b.id])
    const both = await as("x").processing.agentItems("bot-1", {
      status: "processing,completed",
    })
    expect(both.page.total).toBe(2)
    await expect(
      as("x").processing.agentItems("bot-1", { status: "nope" })
    ).rejects.toThrow(ZodError)
  })
})

describe("processing service: concurrency", () => {
  it("N parallel claimers on M items → every item claimed exactly once", async () => {
    const M = 40
    const N = 12
    const items = []
    for (let i = 0; i < M; i++) items.push(await push(i % 3))

    const claimer = async (agentId: string) => {
      const got: string[] = []
      const svc = as(agentId).processing
      for (;;) {
        const res = await svc.claim({ tubeId: tube.id })
        if (!res) return got
        got.push(res.item.id)
      }
    }
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => claimer(`agent-${i}`))
    )
    const claimedIds = results.flat()
    expect(claimedIds).toHaveLength(M)
    expect(new Set(claimedIds).size).toBe(M)
    expect(new Set(claimedIds)).toEqual(new Set(items.map((i) => i.id)))

    for (const item of items) {
      const stored = await storage.items.get(item.id)
      expect(stored).toMatchObject({ status: "processing", attempts: 1 })
      const claims = (await as("x").items.history(item.id)).data.filter(
        (e) => e.action === "claimed"
      )
      expect(claims).toHaveLength(1)
    }
  })
})

describe("lease configuration", () => {
  it("reads MCPOCKET_LEASE_SECONDS", () => {
    expect(leaseSecondsFromEnv({})).toBe(300)
    expect(leaseSecondsFromEnv({ MCPOCKET_LEASE_SECONDS: "30" })).toBe(30)
    expect(() => leaseSecondsFromEnv({ MCPOCKET_LEASE_SECONDS: "0" })).toThrow()
    expect(() =>
      leaseSecondsFromEnv({ MCPOCKET_LEASE_SECONDS: "abc" })
    ).toThrow()
  })
})

describe("tube reset (items.requeueAll)", () => {
  const admin = () => createServices(ctx, { kind: "api_key", id: "ci" })

  it("returns every item to a fresh pending state and keeps the payload", async () => {
    const fresh = await push(0, { n: 1 })
    const done = await push(3, { n: 2 })
    const failed = await push(2, { n: 3 })
    const busy = await push(1, { n: 4 })
    await as("bot").processing.claim({ tubeId: tube.id }) // done (priority 3)
    await as("bot").processing.complete(done.id, { result: { ok: true } })
    await as("bot").processing.claim({ tubeId: tube.id }) // failed (2)
    await as("bot").processing.fail(failed.id, { error: "boom" })
    await as("bot").processing.claim({ tubeId: tube.id }) // busy (1)

    const result = await admin().items.requeueAll(tube.id)
    expect(result).toEqual({ total: 4, matched: 4, requeued: 3 })

    for (const id of [done.id, failed.id, busy.id]) {
      const item = await admin().items.get(id)
      expect(item).toMatchObject({
        status: "pending",
        assignedAgent: null,
        leaseExpiresAt: null,
        attempts: 0,
      })
      expect(item.result).toBeUndefined()
      expect(item.lastError).toBeUndefined()
      expect(item.completedAt).toBeUndefined()
      const {
        data: [latest],
      } = await admin().items.history(id, { limit: 1 })
      expect(latest).toMatchObject({ action: "reset" })
    }
    expect((await admin().items.get(done.id)).payload).toEqual({ n: 2 })
    // untouched fresh item: no extra history
    const freshHistory = await admin().items.history(fresh.id)
    expect(freshHistory.data.map((e) => e.action)).toEqual(["created"])

    // the revoked lease can no longer be completed
    await expect(as("bot").processing.complete(busy.id)).rejects.toThrow(
      ConflictError
    )
    // and everything is claimable again
    expect(
      (await as("bot").processing.claim({ tubeId: tube.id }))?.item.id
    ).toBe(done.id)
  })

  it("resets only the items matching a status filter", async () => {
    // no retries: a failure is final (`failed`, not `retry`)
    await admin().tubes.update(tube.id, { retryPolicy: { maxAttempts: 1 } })
    const done = await push(3, { n: 1 })
    const failed = await push(2, { n: 2 })
    await as("bot").processing.claim({ tubeId: tube.id }) // done
    await as("bot").processing.complete(done.id, { result: { ok: true } })
    await as("bot").processing.claim({ tubeId: tube.id }) // failed
    await as("bot").processing.fail(failed.id, { error: "boom" })

    expect(
      await admin().items.requeueAll(tube.id, { status: "failed" })
    ).toEqual({ total: 2, matched: 1, requeued: 1 })
    expect(await admin().items.get(failed.id)).toMatchObject({
      status: "pending",
      attempts: 0,
    })
    expect(await admin().items.get(done.id)).toMatchObject({
      status: "completed",
    })

    // nothing failed any more
    expect(
      await admin().items.requeueAll(tube.id, { status: ["failed"] })
    ).toEqual({ total: 2, matched: 0, requeued: 0 })
    // no filter: everything (only `done` still needs a reset)
    expect(await admin().items.requeueAll(tube.id)).toEqual({
      total: 2,
      matched: 2,
      requeued: 1,
    })
  })

  it("rejects unknown reset filters", async () => {
    await expect(
      admin().items.requeueAll(tube.id, { status: "nope" })
    ).rejects.toThrow()
    await expect(
      admin().items.requeueAll(tube.id, { bogus: true })
    ).rejects.toThrow()
  })

  it("requires items:manage and an existing tube", async () => {
    const agentKey = createServices(ctx, {
      kind: "agent",
      id: "bot",
      viaKeyId: "k",
      access: { role: "agent", scope: null },
    })
    await expect(agentKey.items.requeueAll(tube.id)).rejects.toThrow(
      ForbiddenError
    )
    await expect(admin().items.requeueAll(crypto.randomUUID())).rejects.toThrow(
      NotFoundError
    )
  })
})

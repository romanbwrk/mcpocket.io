import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ZodError } from "zod"

import type { Actor } from "../domain/actor"
import {
  DEFAULT_RETRY_POLICY,
  decideRetry,
  resolveRetryPolicy,
  retryDefaultsFromEnv,
  retryDelaySeconds,
} from "../domain/retry-policy"
import type { Item, Tube } from "../domain/schemas"
import { EventBus } from "../events/bus"
import type { DomainEvent } from "../events/types"
import {
  createServiceContext,
  createServices,
  sweepExpiredLeases,
  type ServiceContext,
} from "./index"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

import {
  createSweeper,
  getLeaseSweeper,
  startLeaseSweeper,
  stopLeaseSweeper,
  sweeperConfigFromEnv,
} from "./lease-sweeper"

let dataDir: string
let storage: Storage
let ctx: ServiceContext
let nowMs: number
let tube: Tube
let events: DomainEvent[]

const T0 = Date.UTC(2026, 0, 1)
const agent = (id: string): Actor => ({ kind: "agent", id })
const as = (id: string) => createServices(ctx, agent(id))
const admin = () => createServices(ctx, { kind: "api_key", id: "ci" })
/** Fake clock: only moves when the test advances it (plus 1 ms per read). */
const advance = (seconds: number) => {
  nowMs += seconds * 1000
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-retry-"))
  storage = await createJsonStorage({ dataDir })
  nowMs = T0
  const bus = new EventBus()
  events = []
  bus.subscribe((e) => events.push(e))
  ctx = createServiceContext(storage, {
    clock: { now: () => new Date(nowMs++) },
    leaseSeconds: 60,
    retryDefaults: {
      maxAttempts: 3,
      backoff: "exponential",
      delaySeconds: 10,
      maxDelaySeconds: 15,
    },
    events: bus,
  })
  const folder = await admin().folders.create({ name: "f" })
  tube = await admin().tubes.create({ folderId: folder.id, name: "t" })
})
afterEach(async () => {
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

async function push(tubeId = tube.id): Promise<Item> {
  return (await admin().items.push(tubeId, { payload: {} })).item
}

async function claimAndFail(agentId: string, message = "boom") {
  const res = await as(agentId).processing.claim({ tubeId: tube.id })
  expect(res).not.toBeNull()
  return as(agentId).processing.fail(res!.item.id, { error: message })
}

describe("retry policy (domain)", () => {
  it("computes fixed and capped exponential backoff", () => {
    const exp = {
      ...DEFAULT_RETRY_POLICY,
      delaySeconds: 10,
      maxDelaySeconds: 35,
    }
    expect([1, 2, 3, 4, 50].map((n) => retryDelaySeconds(exp, n))).toEqual([
      10, 20, 35, 35, 35,
    ])
    const fixed = { ...exp, backoff: "fixed" as const }
    expect([1, 2, 3].map((n) => retryDelaySeconds(fixed, n))).toEqual([
      10, 10, 10,
    ])
    const now = new Date(T0)
    expect(decideRetry(exp, 1, now)).toEqual({
      retry: true,
      retryAt: new Date(T0 + 10_000).toISOString(),
      delaySeconds: 10,
      maxAttempts: 3,
    })
    expect(decideRetry(exp, 3, now)).toEqual({ retry: false, maxAttempts: 3 })
    expect(decideRetry(exp, 1, now, { immediate: true })).toMatchObject({
      retry: true,
      retryAt: now.toISOString(),
    })
  })

  it("merges tube overrides over defaults and reads defaults from env", () => {
    expect(resolveRetryPolicy({ maxAttempts: 7 })).toEqual({
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: 7,
    })
    expect(resolveRetryPolicy(undefined)).toEqual(DEFAULT_RETRY_POLICY)
    expect(retryDefaultsFromEnv({})).toEqual(DEFAULT_RETRY_POLICY)
    expect(
      retryDefaultsFromEnv({
        MCPOCKET_RETRY_MAX_ATTEMPTS: "5",
        MCPOCKET_RETRY_BACKOFF: "FIXED",
        MCPOCKET_RETRY_DELAY_SECONDS: "0",
        MCPOCKET_RETRY_MAX_DELAY_SECONDS: "60",
      })
    ).toEqual({
      maxAttempts: 5,
      backoff: "fixed",
      delaySeconds: 0,
      maxDelaySeconds: 60,
    })
    expect(() =>
      retryDefaultsFromEnv({ MCPOCKET_RETRY_MAX_ATTEMPTS: "0" })
    ).toThrow(/MCPOCKET_RETRY_MAX_ATTEMPTS/)
    expect(() =>
      retryDefaultsFromEnv({ MCPOCKET_RETRY_BACKOFF: "linear" })
    ).toThrow(/MCPOCKET_RETRY_BACKOFF/)
  })
})

describe("tube retry policy settings", () => {
  it("creates, replaces and clears per-tube overrides", async () => {
    const folder = (await admin().folders.list()).data[0]
    const t = await admin().tubes.create({
      folderId: folder.id,
      name: "with-policy",
      retryPolicy: { maxAttempts: 5, backoff: "fixed" },
    })
    expect(t.retryPolicy).toEqual({ maxAttempts: 5, backoff: "fixed" })
    const replaced = await admin().tubes.update(t.id, {
      retryPolicy: { delaySeconds: 1 },
    })
    expect(replaced.retryPolicy).toEqual({ delaySeconds: 1 })
    expect(
      (await admin().tubes.update(t.id, { retryPolicy: null })).retryPolicy
    ).toBeUndefined()
    expect(
      (await admin().tubes.update(t.id, { retryPolicy: {} })).retryPolicy
    ).toBeUndefined()
    await expect(
      admin().tubes.update(t.id, { retryPolicy: { maxAttempts: 0 } })
    ).rejects.toThrow(ZodError)
    await expect(
      admin().tubes.update(t.id, { retryPolicy: { jitter: true } })
    ).rejects.toThrow(ZodError)
  })
})

describe("fail → retry with backoff", () => {
  it("retries with exponential backoff honoured by claim, then fails for good", async () => {
    const item = await push()

    // attempt 1 fails → retry, not claimable for 10 s
    const first = await claimAndFail("bot-a")
    expect(first).toMatchObject({
      status: "retry",
      attempts: 1,
      leaseExpiresAt: null,
      retryAt: new Date(Date.parse(first.updatedAt) + 10_000).toISOString(),
      lastError: { message: "boom", attempt: 1, agentId: "bot-a" },
    })
    expect(await as("bot-b").processing.claim({ tubeId: tube.id })).toBeNull()
    advance(9)
    expect(await as("bot-b").processing.claim({ tubeId: tube.id })).toBeNull()
    advance(1)

    // attempt 2 fails → retry after 20 s capped at maxDelaySeconds (15 s)
    const second = await claimAndFail("bot-b", "again")
    expect(second).toMatchObject({ status: "retry", attempts: 2 })
    expect(Date.parse(second.retryAt!) - Date.parse(second.updatedAt)).toBe(
      15_000
    )
    advance(15)

    // attempt 3 = maxAttempts → stays failed, never claimable again
    const third = await claimAndFail("bot-a", "final")
    expect(third).toMatchObject({
      status: "failed",
      attempts: 3,
      lastError: { message: "final", attempt: 3 },
    })
    expect(third.retryAt).toBeUndefined()
    advance(3600)
    expect(await as("bot-b").processing.claim({ tubeId: tube.id })).toBeNull()

    const history = (await admin().items.history(item.id)).data
    expect(
      history.filter((e) => e.action === "failed").map((e) => e.newValue)
    ).toEqual([
      expect.objectContaining({ status: "failed", maxAttempts: 3 }),
      expect.objectContaining({
        status: "retry",
        retryAt: second.retryAt,
        maxAttempts: 3,
      }),
      expect.objectContaining({ status: "retry", retryAt: first.retryAt }),
    ])
  })

  it("a not-yet-due retry item does not block other items", async () => {
    const a = await push()
    await claimAndFail("bot")
    const b = await push()
    const res = await as("bot").processing.claim({ tubeId: tube.id })
    expect(res?.item.id).toBe(b.id)
    expect((await admin().items.get(a.id)).status).toBe("retry")
  })

  it("uses the tube's own policy (maxAttempts 1 = no retry, fixed delay)", async () => {
    await admin().tubes.update(tube.id, { retryPolicy: { maxAttempts: 1 } })
    await push()
    expect((await claimAndFail("bot")).status).toBe("failed")

    await admin().tubes.update(tube.id, {
      retryPolicy: { maxAttempts: 4, backoff: "fixed", delaySeconds: 0 },
    })
    await push()
    const failed = await claimAndFail("bot")
    expect(failed.status).toBe("retry")
    expect(failed.retryAt).toBe(failed.updatedAt) // no delay
    expect(
      (await as("bot").processing.claim({ tubeId: tube.id }))?.item.id
    ).toBe(failed.id)
  })

  it("a manual status change (dashboard / PATCH) clears the backoff delay", async () => {
    const item = await push()
    await claimAndFail("bot")
    expect(await as("bot").processing.claim({ tubeId: tube.id })).toBeNull()
    const requeued = await admin().items.update(item.id, { status: "pending" })
    expect(requeued.retryAt).toBeUndefined()
    expect(
      (await as("bot").processing.claim({ tubeId: tube.id }))?.item.id
    ).toBe(item.id)
  })
})

describe("lease sweeper", () => {
  it("returns expired leases to retry with a system history event and item event", async () => {
    const live = await push()
    const dead = await push()
    await as("bot-a").processing.claim({ tubeId: tube.id }) // live
    await as("bot-b").processing.claim({ tubeId: tube.id, leaseSeconds: 5 })
    advance(6)
    events.length = 0

    const result = await sweepExpiredLeases(ctx)
    expect(result).toMatchObject({ requeued: 1, failed: 0 })
    expect(result.items.map((i) => i.id)).toEqual([dead.id])

    const swept = await admin().items.get(dead.id)
    expect(swept).toMatchObject({
      status: "retry",
      leaseExpiresAt: null,
      attempts: 1,
      lastError: { code: "lease_expired", attempt: 1, agentId: "bot-b" },
    })
    expect((await admin().items.get(live.id)).status).toBe("processing")

    const [event] = (await admin().items.history(dead.id)).data
    expect(event).toMatchObject({
      action: "lease_expired",
      actor: "system:lease-sweeper",
      oldValue: { status: "processing", assignedAgent: "bot-b", attempts: 1 },
      newValue: {
        status: "retry",
        maxAttempts: 3,
        retryAt: swept.retryAt,
        error: { code: "lease_expired" },
      },
    })
    expect(events).toEqual([
      expect.objectContaining({
        type: "item.status_changed",
        action: "lease_expired",
        actor: "system:lease-sweeper",
        itemId: dead.id,
        status: "retry",
        previousStatus: "processing",
      }),
    ])

    // immediately claimable again; the old owner lost it
    const res = await as("bot-c").processing.claim({ tubeId: tube.id })
    expect(res?.item).toMatchObject({ id: dead.id, attempts: 2 })
    await expect(as("bot-b").processing.complete(dead.id)).rejects.toThrow(
      /leased by another agent/
    )
  })

  it("fails items whose attempts are exhausted", async () => {
    await admin().tubes.update(tube.id, { retryPolicy: { maxAttempts: 2 } })
    const item = await push()
    for (let i = 0; i < 2; i++) {
      await as("bot").processing.claim({ tubeId: tube.id, leaseSeconds: 1 })
      advance(2)
      await sweepExpiredLeases(ctx)
    }
    const after = await admin().items.get(item.id)
    expect(after).toMatchObject({
      status: "failed",
      attempts: 2,
      leaseExpiresAt: null,
      assignedAgent: "bot",
      lastError: { code: "lease_expired", attempt: 2 },
    })
    const actions = (await admin().items.history(item.id)).data.map(
      (e) => `${e.action}:${(e.newValue as { status?: string })?.status}`
    )
    expect(actions).toEqual([
      "lease_expired:failed",
      "claimed:processing",
      "lease_expired:retry",
      "claimed:processing",
      "created:pending",
    ])
    expect(await as("bot").processing.claim({ tubeId: tube.id })).toBeNull()
  })

  it("does nothing (no write) when no lease has expired", async () => {
    await push()
    await as("bot").processing.claim({ tubeId: tube.id })
    const tx = vi.spyOn(storage, "transaction")
    expect(await sweepExpiredLeases(ctx)).toEqual({
      requeued: 0,
      failed: 0,
      items: [],
    })
    expect(tx).not.toHaveBeenCalled()
  })

  it("is safe alongside concurrent claims (each item claimed once per lease)", async () => {
    const items = await Promise.all(Array.from({ length: 20 }, () => push()))
    // half of them are held by a dead agent
    for (let i = 0; i < 10; i++) {
      await as("dead").processing.claim({ tubeId: tube.id, leaseSeconds: 1 })
    }
    advance(5)
    const claims = await Promise.all([
      sweepExpiredLeases(ctx),
      ...Array.from({ length: 25 }, (_, i) =>
        as(`bot-${i}`).processing.claim({ tubeId: tube.id })
      ),
      sweepExpiredLeases(ctx),
    ])
    const claimed = claims
      .slice(1, -1)
      .flatMap((c) => (c && "claim" in c ? [c.item.id] : []))
    expect(claimed).toHaveLength(20)
    expect(new Set(claimed).size).toBe(20)
    for (const item of items) {
      const history = (await admin().items.history(item.id)).data
      expect(
        history.filter((e) => e.action === "lease_expired").length
      ).toBeLessThanOrEqual(1)
    }
  })
})

describe("sweeper runner", () => {
  afterEach(() => {
    stopLeaseSweeper()
    vi.useRealTimers()
  })

  it("reads env config", () => {
    expect(sweeperConfigFromEnv({})).toEqual({
      enabled: true,
      intervalSeconds: 15,
    })
    expect(
      sweeperConfigFromEnv({
        MCPOCKET_SWEEPER_ENABLED: "false",
        MCPOCKET_SWEEPER_INTERVAL_SECONDS: "5",
      })
    ).toEqual({ enabled: false, intervalSeconds: 5 })
    expect(() =>
      sweeperConfigFromEnv({ MCPOCKET_SWEEPER_INTERVAL_SECONDS: "0" })
    ).toThrow(/INTERVAL/)
    expect(() =>
      sweeperConfigFromEnv({ MCPOCKET_SWEEPER_ENABLED: "maybe" })
    ).toThrow(/ENABLED/)
  })

  it("ticks on its interval, never overlaps passes and survives errors", async () => {
    vi.useFakeTimers()
    let resolveSweep: (() => void) | undefined
    const sweep = vi.fn(
      () =>
        new Promise<{ requeued: number; failed: number; items: Item[] }>(
          (resolve) => {
            resolveSweep = () => resolve({ requeued: 0, failed: 0, items: [] })
          }
        )
    )
    const onError = vi.fn()
    const sweeper = createSweeper({ intervalMs: 1000, sweep, onError })

    await vi.advanceTimersByTimeAsync(999)
    expect(sweep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sweep).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000) // first pass still running
    expect(sweep).toHaveBeenCalledTimes(1)
    resolveSweep!()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sweep).toHaveBeenCalledTimes(2)
    resolveSweep!()

    sweep.mockImplementationOnce(() => Promise.reject(new Error("disk full")))
    await vi.advanceTimersByTimeAsync(1000)
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    await vi.advanceTimersByTimeAsync(1000)
    expect(sweep).toHaveBeenCalledTimes(4)
    resolveSweep!()

    sweeper.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sweep).toHaveBeenCalledTimes(4)
  })

  it("keeps a single process-wide instance and can be disabled", () => {
    const first = startLeaseSweeper({})
    expect(first).not.toBeNull()
    expect(getLeaseSweeper()).toBe(first)
    const second = startLeaseSweeper({ MCPOCKET_SWEEPER_INTERVAL_SECONDS: "2" })
    expect(getLeaseSweeper()).toBe(second)
    expect(second?.intervalMs).toBe(2000)
    expect(startLeaseSweeper({ MCPOCKET_SWEEPER_ENABLED: "off" })).toBeNull()
    expect(getLeaseSweeper()).toBeUndefined()
  })
})

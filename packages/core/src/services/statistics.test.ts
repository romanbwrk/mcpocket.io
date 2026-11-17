import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ZodError } from "zod"

import type { Actor } from "../domain/actor"
import { NotFoundError } from "../domain/errors"
import type { Tube } from "../domain/schemas"
import {
  createServiceContext,
  createServices,
  type ServiceContext,
} from "./index"
import { DEFAULT_RETRY_POLICY } from "../domain/retry-policy"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

let dataDir: string
let storage: Storage
let ctx: ServiceContext
let nowMs: number
let tubeA: Tube
let tubeB: Tube

const MISSING = "00000000-0000-4000-8000-000000000000"
const agent = (id: string): Actor => ({ kind: "agent", id })
const as = (id: string) => createServices(ctx, agent(id))
const admin = () => createServices(ctx, { kind: "api_key", id: "ci" })

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-stats-"))
  storage = await createJsonStorage({ dataDir })
  nowMs = Date.UTC(2026, 0, 1)
  ctx = createServiceContext(storage, {
    clock: { now: () => new Date(nowMs++) },
    leaseSeconds: 60,
    retryDefaults: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 }, // fail is final
  })
  const folder = await admin().folders.create({ name: "f" })
  tubeA = await admin().tubes.create({ folderId: folder.id, name: "A" })
  tubeB = await admin().tubes.create({ folderId: folder.id, name: "B" })
})
afterEach(async () => {
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

const push = (tubeId: string, n: number) =>
  admin().items.push(tubeId, { payload: { n } })

/** A: 1 completed (bot-1), 1 failed (bot-2), 1 processing (bot-1), 1 pending, 1 cancelled, 1 deleted. B: 1 failed (bot-1), 1 pending. */
async function scenario() {
  for (let n = 0; n < 6; n++) await push(tubeA.id, n)
  for (let n = 0; n < 2; n++) await push(tubeB.id, n)
  const bot1 = as("bot-1")
  const bot2 = as("bot-2")

  const c1 = (await bot1.processing.claim({ tubeId: tubeA.id }))!
  await bot1.processing.heartbeat(c1.item.id, {})
  await bot1.processing.complete(c1.item.id, { result: { ok: true } })

  const c2 = (await bot2.processing.claim({ tubeId: tubeA.id }))!
  await bot2.processing.fail(c2.item.id, {
    error: { message: "boom", code: "E_BOOM" },
  })

  const c3 = (await bot1.processing.claim({ tubeId: tubeA.id }))!
  await bot1.processing.heartbeat(c3.item.id, {})

  const rest = (await admin().items.list(tubeA.id, { status: "pending" })).data
  await admin().items.update(rest[0].id, { status: "cancelled" })
  await admin().items.delete(rest[1].id)

  const c4 = (await bot1.processing.claim({ tubeId: tubeB.id }))!
  await bot1.processing.fail(c4.item.id, { error: "nope" })

  return {
    completed: c1.item,
    failedA: c2.item,
    processing: c3.item,
    failedB: c4.item,
  }
}

describe("statistics service", () => {
  it("counts items by status globally (deleted excluded)", async () => {
    await scenario()
    const stats = await admin().statistics.global()
    expect(stats).toEqual({
      counts: {
        total: 7,
        pending: 2,
        processing: 1,
        completed: 1,
        failed: 2,
        retry: 0,
        cancelled: 1,
        archived: 0,
      },
      folders: 1,
      tubes: 2,
      agents: 2,
      generatedAt: expect.any(String),
    })
  })

  it("counts items by status per tube; 404 / 400 on missing / bad id", async () => {
    await scenario()
    expect(await admin().statistics.tube(tubeB.id)).toEqual({
      tubeId: tubeB.id,
      tubeName: "B",
      folderId: tubeB.folderId,
      enabled: true,
      counts: {
        total: 2,
        pending: 1,
        processing: 0,
        completed: 0,
        failed: 1,
        retry: 0,
        cancelled: 0,
        archived: 0,
      },
      generatedAt: expect.any(String),
    })
    expect((await admin().statistics.tube(tubeA.id)).counts.total).toBe(5)
    await expect(admin().statistics.tube(MISSING)).rejects.toBeInstanceOf(
      NotFoundError
    )
    await expect(admin().statistics.tube("nope")).rejects.toBeInstanceOf(
      ZodError
    )
  })

  it("derives agent stats from items and history", async () => {
    const { processing } = await scenario()
    const res = await admin().statistics.agents()
    expect(res.page).toEqual({ offset: 0, limit: 100, total: 2 })
    const [first, second] = res.data
    // bot-1 acted last (fail on tube B) → first.
    expect(first).toEqual({
      agentId: "bot-1",
      assigned: 3,
      processing: 1,
      completed: 1,
      failed: 1,
      lastHeartbeatAt: expect.any(String),
      lastSeenAt: expect.any(String),
    })
    const hb = await storage.history.list({ itemId: processing.id })
    expect(first.lastHeartbeatAt).toBe(
      hb.find((e) => e.action === "heartbeat")!.createdAt
    )
    expect(first.lastSeenAt! > first.lastHeartbeatAt!).toBe(true)
    expect(second).toEqual({
      agentId: "bot-2",
      assigned: 1,
      processing: 0,
      completed: 0,
      failed: 1,
      lastHeartbeatAt: null,
      lastSeenAt: expect.any(String),
    })

    const one = await admin().statistics.agents({ agentId: "bot-2" })
    expect(one.data.map((a) => a.agentId)).toEqual(["bot-2"])
    const paged = await admin().statistics.agents({ offset: 1, limit: 1 })
    expect(paged).toEqual({
      data: [second],
      page: { offset: 1, limit: 1, total: 2 },
    })
  })

  it("counts completions per agent even after the item is reassigned", async () => {
    const { item } = await push(tubeA.id, 1)
    const bot1 = as("bot-1")
    await bot1.processing.claim({ tubeId: tubeA.id })
    await bot1.processing.fail(item.id, { error: "x" })
    await admin().items.update(item.id, { status: "pending" })
    const bot2 = as("bot-2")
    await bot2.processing.claim({ tubeId: tubeA.id })
    await bot2.processing.complete(item.id, {})
    const { data } = await admin().statistics.agents()
    const byId = Object.fromEntries(data.map((a) => [a.agentId, a]))
    expect(byId["bot-1"]).toMatchObject({
      assigned: 0,
      failed: 1,
      completed: 0,
    })
    expect(byId["bot-2"]).toMatchObject({
      assigned: 1,
      failed: 0,
      completed: 1,
    })
  })

  it("lists processing errors newest first, filterable and paginated", async () => {
    const { failedA, failedB } = await scenario()
    const all = await admin().statistics.errors()
    expect(all.page.total).toBe(2)
    expect(all.data.map((e) => e.itemId)).toEqual([failedB.id, failedA.id])
    expect(all.data[1]).toEqual({
      itemId: failedA.id,
      tubeId: tubeA.id,
      status: "failed",
      attempts: 1,
      assignedAgent: "bot-2",
      error: {
        message: "boom",
        code: "E_BOOM",
        at: expect.any(String),
        attempt: 1,
        agentId: "bot-2",
      },
      failedAt: all.data[1].error!.at,
    })

    const inA = await admin().statistics.errors({ tubeId: tubeA.id })
    expect(inA.data.map((e) => e.itemId)).toEqual([failedA.id])
    const byAgent = await admin().statistics.errors({ agentId: "bot-1" })
    expect(byAgent.data.map((e) => e.itemId)).toEqual([failedB.id])
    const paged = await admin().statistics.errors({ offset: "1", limit: "1" })
    expect(paged.data.map((e) => e.itemId)).toEqual([failedA.id])
    expect(paged.page).toEqual({ offset: 1, limit: 1, total: 2 })
    const cancelled = await admin().statistics.errors({ status: "cancelled" })
    expect(cancelled.data).toEqual([
      expect.objectContaining({ status: "cancelled", error: null }),
    ])
    await expect(
      admin().statistics.errors({ tubeId: "bad" })
    ).rejects.toBeInstanceOf(ZodError)
  })
})

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Actor } from "../domain/actor"
import { ForbiddenError } from "../domain/errors"
import type { Folder, Tube } from "../domain/schemas"
import { EventBus } from "../events/bus"
import {
  createServiceContext,
  createServices,
  sweepExpiredLeases,
  transact,
  type ServiceContext,
} from "./index"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"
import {
  SIGNATURE_HEADER,
  signWebhookPayload,
  verifyWebhookSignature,
} from "../webhooks/signature"

import {
  createWebhookDispatcher,
  DEFAULT_WEBHOOK_CONFIG,
  dispatchWebhooks,
  webhookConfigFromEnv,
  webhookRetryDelaySeconds,
  type DispatchResult,
  type FetchLike,
  type WebhookDispatchConfig,
} from "./webhook-dispatcher"

let dataDir: string
let storage: Storage
let ctx: ServiceContext
let bus: EventBus
let nowMs: number
let folder: Folder
let sub: Folder
let tube: Tube
let subTube: Tube

const T0 = Date.UTC(2026, 0, 1)
const admin = () => createServices(ctx, { kind: "user", id: "admin" })
const as = (actor: Actor) => createServices(ctx, actor)
const advance = (seconds: number) => {
  nowMs += seconds * 1000
}
const config: WebhookDispatchConfig = {
  ...DEFAULT_WEBHOOK_CONFIG,
  maxAttempts: 3,
  backoffSeconds: 10,
  maxBackoffSeconds: 15,
  retentionDays: 0,
}

async function makeContext() {
  storage = await createJsonStorage({ dataDir })
  ctx = createServiceContext(storage, {
    clock: { now: () => new Date(nowMs++) },
    events: bus,
    retryDefaults: {
      maxAttempts: 1,
      backoff: "fixed",
      delaySeconds: 1,
      maxDelaySeconds: 1,
    },
  })
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-webhooks-"))
  nowMs = T0
  bus = new EventBus()
  await makeContext()
  folder = await admin().folders.create({ name: "root" })
  sub = await admin().folders.create({ name: "sub", parentId: folder.id })
  tube = await admin().tubes.create({ folderId: folder.id, name: "t" })
  subTube = await admin().tubes.create({ folderId: sub.id, name: "st" })
})
afterEach(async () => {
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

const hook = (input: Record<string, unknown> = {}) =>
  admin().webhooks.create({
    name: "h",
    url: "http://127.0.0.1:9/hook",
    ...input,
  })

const push = async (tubeId = tube.id, payload: unknown = { n: 1 }) =>
  (await admin().items.push(tubeId, { payload })).item

const deliveries = async () => storage.webhookDeliveries.list()

/** Injected fetch returning queued statuses (or throwing for `"error"`). */
function fakeFetch(...responses: (number | "error")[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = responses.length > 1 ? responses.shift()! : responses[0]
    if (next === "error") throw new TypeError("fetch failed")
    return { status: next, text: async () => `status ${next}` }
  }
  return { fn, calls }
}

describe("signature", () => {
  it("signs and verifies with timestamp tolerance", () => {
    const body = JSON.stringify({ a: 1 })
    const t = Math.floor(T0 / 1000)
    const header = signWebhookPayload("whsec_secret_value_123", body, t)
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    const now = new Date(T0 + 60_000)
    expect(
      verifyWebhookSignature("whsec_secret_value_123", header, body, { now })
    ).toBe(true)
    expect(
      verifyWebhookSignature("whsec_other_secret_1234", header, body, { now })
    ).toBe(false)
    expect(
      verifyWebhookSignature("whsec_secret_value_123", header, body + " ", {
        now,
      })
    ).toBe(false)
    expect(
      verifyWebhookSignature("whsec_secret_value_123", header, body, {
        now: new Date(T0 + 10 * 60_000),
      })
    ).toBe(false)
    expect(verifyWebhookSignature("x", "garbage", body)).toBe(false)
  })
})

describe("subscriptions", () => {
  it("returns the secret only on create / rotate and audits changes", async () => {
    const { webhook, secret } = await hook({ eventTypes: ["item.created"] })
    expect(secret).toMatch(/^whsec_/)
    expect(webhook).not.toHaveProperty("secret")
    expect(webhook.secretPrefix).toBe(secret.slice(0, 10))
    expect(JSON.stringify(await admin().webhooks.list())).not.toContain(secret)
    expect(
      JSON.stringify(await admin().webhooks.get(webhook.id))
    ).not.toContain(secret)

    const updated = await admin().webhooks.update(webhook.id, {
      enabled: false,
      tubeId: tube.id,
    })
    expect(updated).toMatchObject({ enabled: false, tubeId: tube.id })
    const rotated = await admin().webhooks.rotateSecret(webhook.id)
    expect(rotated.secret).not.toBe(secret)

    const audit = await admin().apiKeys.auditLog({ targetType: "webhook" })
    expect(audit.data.map((e) => e.action)).toEqual([
      "webhook.secret_rotated",
      "webhook.updated",
      "webhook.created",
    ])
    const auditText = JSON.stringify(audit.data)
    expect(auditText).not.toContain(secret)
    expect(auditText).not.toContain(rotated.secret)
  })

  it("validates url, scope and event types", async () => {
    await expect(hook({ url: "ftp://x" })).rejects.toThrow()
    await expect(hook({ eventTypes: ["nope"] })).rejects.toThrow()
    await expect(
      hook({ folderId: folder.id, tubeId: tube.id })
    ).rejects.toThrow()
    await expect(
      hook({ tubeId: "00000000-0000-4000-8000-000000000000" })
    ).rejects.toMatchObject({ code: "not_found" })
  })

  it("requires access:manage", async () => {
    const operator: Actor = {
      kind: "api_key",
      id: "op",
      access: { role: "operator", scope: null },
    }
    await expect(as(operator).webhooks.list()).rejects.toBeInstanceOf(
      ForbiddenError
    )
    await expect(
      as(operator).webhooks.create({ name: "x", url: "http://x.test" })
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it("delete removes the subscription and its deliveries", async () => {
    const { webhook } = await hook()
    await push()
    expect(await deliveries()).toHaveLength(1)
    await admin().webhooks.delete(webhook.id)
    expect(await deliveries()).toHaveLength(0)
    expect(await storage.webhooks.count()).toBe(0)
  })
})

describe("transactional outbox", () => {
  it("writes one row per matching subscription in the same persist as the change", async () => {
    const all = (await hook()).webhook
    const created = (await hook({ eventTypes: ["item.created"] })).webhook
    const tubeOnly = (await hook({ tubeId: subTube.id })).webhook
    const subtree = (await hook({ folderId: sub.id })).webhook
    await hook({ enabled: false })

    const item = await push(tube.id)
    let rows = await deliveries()
    expect(rows.map((r) => r.webhookId).sort()).toEqual(
      [all.id, created.id].sort()
    )
    expect(rows[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      eventType: "item.created",
      payload: {
        type: "item.created",
        data: {
          action: "created",
          itemId: item.id,
          tubeId: tube.id,
          folderId: folder.id,
          status: "pending",
          item: { id: item.id, payload: { n: 1 } },
        },
      },
    })
    // Same event → same event id across subscriptions.
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(1)

    await push(subTube.id)
    rows = await storage.webhookDeliveries.list({ newestFirst: true })
    expect(
      rows
        .slice(0, 4)
        .map((r) => r.webhookId)
        .sort()
    ).toEqual([all.id, created.id, tubeOnly.id, subtree.id].sort())

    // Persisted: the outbox file holds the rows next to the item file.
    const file = JSON.parse(
      await readFile(path.join(dataDir, "webhook-deliveries.json"), "utf8")
    )
    expect(file).toHaveLength(6)
  })

  it("matches event types (status changes, deletes)", async () => {
    const { webhook } = await hook({
      eventTypes: ["item.status_changed", "item.deleted"],
    })
    const item = await push()
    expect(await deliveries()).toHaveLength(0)
    const agent = as({ kind: "agent", id: "a1" })
    await agent.processing.claim({ tubeId: tube.id })
    await agent.processing.complete(item.id, { result: { ok: true } })
    await admin().items.delete(item.id)
    const rows = await storage.webhookDeliveries.list()
    expect(rows.map((r) => [r.eventType, r.payload.data])).toEqual([
      [
        "item.status_changed",
        expect.objectContaining({
          action: "claimed",
          status: "processing",
          previousStatus: "pending",
        }),
      ],
      [
        "item.status_changed",
        expect.objectContaining({
          action: "completed",
          status: "completed",
          assignedAgent: "a1",
        }),
      ],
      ["item.deleted", expect.objectContaining({ action: "deleted" })],
    ])
    expect(rows.every((r) => r.webhookId === webhook.id)).toBe(true)
  })

  it("rolls back: a failed transaction writes no outbox row", async () => {
    await hook()
    await expect(
      transact(ctx, async () => {
        await admin().items.push(tube.id, { payload: {} })
        throw new Error("boom after push")
      })
    ).rejects.toThrow("boom after push")
    expect(await storage.items.count()).toBe(0)
    expect(await deliveries()).toHaveLength(0)

    // ...and a failing outbox write rolls back the item change.
    const spy = vi
      .spyOn(storage.webhookDeliveries, "create")
      .mockRejectedValueOnce(new Error("disk full"))
    await expect(push()).rejects.toThrow("disk full")
    spy.mockRestore()
    expect(await storage.items.count()).toBe(0)
    expect(await deliveries()).toHaveLength(0)
  })

  it("bulk pushes write all rows in the one transaction", async () => {
    await hook()
    await admin().items.bulkPush(tube.id, {
      items: [
        { payload: { a: 1 } },
        { payload: { a: 2 } },
        { payload: { a: 3 } },
      ],
    })
    const rows = await deliveries()
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(3)
  })

  it("lease expiry by the sweeper is published too", async () => {
    await hook({ eventTypes: ["item.status_changed"] })
    const item = await push()
    await as({ kind: "agent", id: "a1" }).processing.claim({
      tubeId: tube.id,
      leaseSeconds: 5,
    })
    advance(10)
    await sweepExpiredLeases(ctx)
    const rows = await storage.webhookDeliveries.list()
    expect(rows.at(-1)?.payload.data).toMatchObject({
      action: "lease_expired",
      itemId: item.id,
      status: "failed",
    })
  })

  it("non-item writes and no subscriptions write nothing", async () => {
    await push()
    expect(await deliveries()).toHaveLength(0)
    await hook()
    await admin().folders.create({ name: "x" })
    expect(await deliveries()).toHaveLength(0)
  })
})

describe("dispatcher", () => {
  it("retries with exponential backoff and dead-letters after maxAttempts", async () => {
    const { webhook } = await hook()
    await push()
    const fetch = fakeFetch(500)

    let r = await dispatchWebhooks(ctx, { config, fetch: fetch.fn })
    expect(r).toMatchObject({ attempted: 1, retrying: 1, delivered: 0 })
    let [row] = await deliveries()
    expect(row).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "HTTP 500",
    })
    expect(
      Date.parse(row.nextAttemptAt!) - Date.parse(row.lastAttemptAt!)
    ).toBe(
      10_000 + (Date.parse(row.updatedAt) - Date.parse(row.lastAttemptAt!))
    )

    // Not due yet: nothing is sent.
    advance(5)
    r = await dispatchWebhooks(ctx, { config, fetch: fetch.fn })
    expect(r.attempted).toBe(0)
    expect(fetch.calls).toHaveLength(1)

    advance(6)
    r = await dispatchWebhooks(ctx, { config, fetch: fetch.fn })
    expect(r.retrying).toBe(1)
    ;[row] = await deliveries()
    expect(row.attempts).toBe(2)
    // Second delay = min(10 * 2, 15) = 15 s
    expect(Date.parse(row.nextAttemptAt!) - Date.parse(row.updatedAt)).toBe(
      15_000
    )

    advance(16)
    r = await dispatchWebhooks(ctx, { config, fetch: fetch.fn })
    expect(r.dead).toBe(1)
    ;[row] = await deliveries()
    expect(row).toMatchObject({
      status: "dead",
      attempts: 3,
      nextAttemptAt: null,
    })
    expect(row.attemptLog.map((a) => a.statusCode)).toEqual([500, 500, 500])
    expect(row.attemptLog[0]).toMatchObject({ ok: false, error: "HTTP 500" })
    expect(
      fetch.calls.map(
        (c) => (c.init.headers as Record<string, string>)["x-mcpocket-attempt"]
      )
    ).toEqual(["1", "2", "3"])

    advance(3600)
    expect(
      (await dispatchWebhooks(ctx, { config, fetch: fetch.fn })).attempted
    ).toBe(0)

    // Manual retry → fresh budget, delivered on success.
    const retried = await admin().webhooks.retryDelivery(row.id)
    expect(retried).toMatchObject({ status: "pending", attempts: 0 })
    r = await dispatchWebhooks(ctx, { config, fetch: fakeFetch(204).fn })
    expect(r.delivered).toBe(1)
    ;[row] = await deliveries()
    expect(row).toMatchObject({
      status: "delivered",
      attempts: 1,
      lastError: null,
    })
    expect(row.attemptLog).toHaveLength(4)
    expect((await admin().webhooks.get(webhook.id)).deliveries).toEqual({
      pending: 0,
      delivered: 1,
      dead: 0,
    })
  })

  it("records network errors and treats redirects as failures", async () => {
    await hook()
    await push()
    await dispatchWebhooks(ctx, { config, fetch: fakeFetch("error").fn })
    let [row] = await deliveries()
    expect(row.attemptLog[0]).toMatchObject({
      statusCode: null,
      ok: false,
      error: "fetch failed",
    })
    advance(60)
    await dispatchWebhooks(ctx, { config, fetch: fakeFetch(302).fn })
    ;[row] = await deliveries()
    expect(row).toMatchObject({ status: "pending", lastError: "HTTP 302" })
  })

  it("keeps deliveries of disabled subscriptions pending", async () => {
    const { webhook } = await hook()
    await push()
    await admin().webhooks.update(webhook.id, { enabled: false })
    const fetch = fakeFetch(200)
    expect(
      (await dispatchWebhooks(ctx, { config, fetch: fetch.fn })).attempted
    ).toBe(0)
    await admin().webhooks.update(webhook.id, { enabled: true })
    expect(
      (await dispatchWebhooks(ctx, { config, fetch: fetch.fn })).delivered
    ).toBe(1)
  })

  it("delivers signed payloads to a real HTTP receiver", async () => {
    const received: { headers: IncomingMessage["headers"]; body: string }[] = []
    const server: Server = createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        received.push({ headers: req.headers, body })
        res.writeHead(200).end("ok")
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const { webhook, secret } = await hook({
        url: `http://127.0.0.1:${port}/hooks`,
      })
      const item = await push()
      const r = await dispatchWebhooks(ctx, { config })
      expect(r.delivered).toBe(1)
      expect(received).toHaveLength(1)
      const [{ headers, body }] = received
      const [row] = await deliveries()
      expect(headers["content-type"]).toBe("application/json")
      expect(headers["x-mcpocket-event"]).toBe("item.created")
      expect(headers["x-mcpocket-delivery"]).toBe(row.id)
      expect(headers["x-mcpocket-webhook-id"]).toBe(webhook.id)
      expect(
        verifyWebhookSignature(
          secret,
          headers[SIGNATURE_HEADER] as string,
          body,
          { now: new Date(nowMs) }
        )
      ).toBe(true)
      expect(JSON.parse(body)).toMatchObject({
        type: "item.created",
        data: { itemId: item.id },
      })
      expect(body).not.toContain(secret)
      expect(row).toMatchObject({ status: "delivered" })
      expect(row.attemptLog[0]).toMatchObject({
        statusCode: 200,
        ok: true,
        responseBody: "ok",
      })

      // Ping via test().
      await admin().webhooks.test(webhook.id)
      await dispatchWebhooks(ctx, { config })
      expect(received[1].headers["x-mcpocket-event"]).toBe("webhook.ping")
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("survives a restart: pending rows are delivered by the next process", async () => {
    await hook()
    await push()
    await push()
    await storage.close()
    await makeContext() // fresh storage loaded from disk
    expect(await storage.webhookDeliveries.count({ status: "pending" })).toBe(2)
    const r = await dispatchWebhooks(ctx, { config, fetch: fakeFetch(200).fn })
    expect(r.delivered).toBe(2)
  })

  it("prunes old finished deliveries", async () => {
    await hook()
    await push()
    await dispatchWebhooks(ctx, { config, fetch: fakeFetch(200).fn })
    advance(2 * 86_400)
    const r = await dispatchWebhooks(ctx, {
      config: { ...config, retentionDays: 1 },
      fetch: fakeFetch(200).fn,
    })
    expect(r.pruned).toBe(1)
    expect(await deliveries()).toHaveLength(0)
  })

  it("backoff and env config", () => {
    expect(
      [1, 2, 3, 10].map((n) =>
        webhookRetryDelaySeconds(n, {
          backoffSeconds: 10,
          maxBackoffSeconds: 60,
        })
      )
    ).toEqual([10, 20, 40, 60])
    expect(webhookConfigFromEnv({})).toEqual(DEFAULT_WEBHOOK_CONFIG)
    expect(
      webhookConfigFromEnv({
        MCPOCKET_WEBHOOKS_ENABLED: "false",
        MCPOCKET_WEBHOOK_MAX_ATTEMPTS: "4",
      })
    ).toMatchObject({ enabled: false, maxAttempts: 4 })
    expect(() =>
      webhookConfigFromEnv({ MCPOCKET_WEBHOOK_INTERVAL_SECONDS: "0" })
    ).toThrow()
    expect(() =>
      webhookConfigFromEnv({
        MCPOCKET_WEBHOOK_BACKOFF_SECONDS: "100",
        MCPOCKET_WEBHOOK_MAX_BACKOFF_SECONDS: "10",
      })
    ).toThrow()
  })
})

describe("background worker", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("runs on the interval, on item events (nudge) and never overlaps", async () => {
    vi.useFakeTimers()
    const results: DispatchResult[] = []
    let calls = 0
    let release: () => void = () => {}
    const dispatch = vi.fn(async (): Promise<DispatchResult> => {
      calls++
      await new Promise<void>((resolve) => (release = resolve))
      return {
        attempted: 0,
        delivered: 0,
        retrying: 0,
        dead: 0,
        pruned: 0,
        more: false,
      }
    })
    const worker = createWebhookDispatcher({
      intervalMs: 5000,
      dispatch,
      bus,
      onDispatch: (r) => results.push(r),
    })
    try {
      // An item event nudges a pass shortly after.
      await push()
      await vi.advanceTimersByTimeAsync(150)
      expect(calls).toBe(1)
      // While running: interval tick and nudges don't start a second pass...
      await vi.advanceTimersByTimeAsync(5000)
      await push()
      expect(calls).toBe(1)
      // ...but a follow-up pass runs after it finishes.
      release()
      await vi.advanceTimersByTimeAsync(150)
      expect(calls).toBe(2)
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(results).toHaveLength(2)
    } finally {
      worker.stop()
    }
    expect(bus.listenerCount).toBe(0)
  })
})

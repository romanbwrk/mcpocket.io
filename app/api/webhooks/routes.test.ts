import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetRateLimiters } from "@mcpocket/core/api/rate-limit"
import { systemActor } from "@mcpocket/core/domain/actor"
import { getServices } from "@mcpocket/core/services"
import { dispatchWebhooks } from "@mcpocket/core/services/webhook-dispatcher"
import { resetStorageSingleton } from "@mcpocket/core/storage"

import * as foldersRoute from "../folders/route"
import * as itemsRoute from "../tubes/[id]/items/route"
import * as tubesRoute from "../tubes/route"
import * as deliveriesRoute from "./[id]/deliveries/route"
import * as rotateRoute from "./[id]/rotate-secret/route"
import * as webhookRoute from "./[id]/route"
import * as testRoute from "./[id]/test/route"
import * as deliveryRetryRoute from "./deliveries/[id]/retry/route"
import * as deliveryRoute from "./deliveries/[id]/route"
import * as allDeliveriesRoute from "./deliveries/route"
import * as webhooksRoute from "./route"

const ADMIN = "admin-secret"
const OPERATOR = "operator-secret"
let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-webhook-routes-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_API_KEYS", `ci:${ADMIN},ops:${OPERATOR}`)
  vi.stubEnv("MCPOCKET_API_KEY_ROLES", "ops:operator")
  await resetStorageSingleton()
  resetRateLimiters()
})
afterEach(async () => {
  await resetStorageSingleton()
  resetRateLimiters()
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

const req = (url: string, init: RequestInit & { key?: string } = {}) => {
  const { key = ADMIN, ...rest } = init
  const headers = new Headers(rest.headers)
  headers.set("authorization", `Bearer ${key}`)
  if (rest.body) headers.set("content-type", "application/json")
  return new Request(`http://localhost${url}`, { ...rest, headers })
}
const json = (body: unknown) => JSON.stringify(body)
const params = <P>(p: P) => ({ params: Promise.resolve(p) })

async function setup() {
  const folder = (
    await (
      await foldersRoute.POST(
        req("/api/folders", { method: "POST", body: json({ name: "F" }) })
      )
    ).json()
  ).data
  const tube = (
    await (
      await tubesRoute.POST(
        req("/api/tubes", {
          method: "POST",
          body: json({ folderId: folder.id, name: "T" }),
        })
      )
    ).json()
  ).data
  return { folder, tube }
}

describe("webhook REST API", () => {
  it("manages subscriptions without ever returning the secret again", async () => {
    const { tube } = await setup()
    const res = await webhooksRoute.POST(
      req("/api/webhooks", {
        method: "POST",
        body: json({
          name: "CRM",
          url: "https://crm.example.com/hooks",
          eventTypes: ["item.status_changed"],
          tubeId: tube.id,
        }),
      })
    )
    expect(res.status).toBe(201)
    const { data: created, secret } = await res.json()
    expect(secret).toMatch(/^whsec_/)
    expect(created).toMatchObject({
      name: "CRM",
      tubeId: tube.id,
      enabled: true,
      deliveries: { pending: 0, delivered: 0, dead: 0 },
    })
    expect(created).not.toHaveProperty("secret")

    const list = await webhooksRoute.GET(req("/api/webhooks"))
    const listText = await list.text()
    expect(JSON.parse(listText).data).toHaveLength(1)
    expect(listText).not.toContain(secret)

    const patched = await webhookRoute.PATCH(
      req(`/api/webhooks/${created.id}`, {
        method: "PATCH",
        body: json({ enabled: false, tubeId: null }),
      }),
      params({ id: created.id })
    )
    expect((await patched.json()).data).toMatchObject({
      enabled: false,
      tubeId: null,
    })

    const bad = await webhookRoute.PATCH(
      req(`/api/webhooks/${created.id}`, {
        method: "PATCH",
        body: json({ url: "javascript:alert(1)" }),
      }),
      params({ id: created.id })
    )
    expect(bad.status).toBe(400)

    const rotated = await rotateRoute.POST(
      req(`/api/webhooks/${created.id}/rotate-secret`, { method: "POST" }),
      params({ id: created.id })
    )
    const rotatedBody = await rotated.json()
    expect(rotatedBody.secret).not.toBe(secret)

    // A disabled webhook can't be pinged.
    const ping = await testRoute.POST(
      req(`/api/webhooks/${created.id}/test`, { method: "POST" }),
      params({ id: created.id })
    )
    expect(ping.status).toBe(409)

    const del = await webhookRoute.DELETE(
      req(`/api/webhooks/${created.id}`, { method: "DELETE" }),
      params({ id: created.id })
    )
    expect(del.status).toBe(204)
    const gone = await webhookRoute.GET(
      req(`/api/webhooks/${created.id}`),
      params({ id: created.id })
    )
    expect(gone.status).toBe(404)
  })

  it("exposes the outbox: deliveries, attempts and manual retry", async () => {
    const { tube } = await setup()
    const { data: webhook, secret } = await (
      await webhooksRoute.POST(
        req("/api/webhooks", {
          method: "POST",
          body: json({ name: "h", url: "http://127.0.0.1:9/never" }),
        })
      )
    ).json()
    const pushed = await itemsRoute.POST(
      req(`/api/tubes/${tube.id}/items`, {
        method: "POST",
        body: json({ payload: { hello: "world" } }),
      }),
      params({ id: tube.id })
    )
    expect(pushed.status).toBe(201)

    const services = await getServices(systemActor())
    await dispatchWebhooks(services.ctx, {
      fetch: async () => ({ status: 503, text: async () => "busy" }),
    })

    const page = await (
      await deliveriesRoute.GET(
        req(`/api/webhooks/${webhook.id}/deliveries?status=pending`),
        params({ id: webhook.id })
      )
    ).json()
    expect(page.page.total).toBe(1)
    const [delivery] = page.data
    expect(delivery).toMatchObject({
      eventType: "item.created",
      status: "pending",
      attempts: 1,
      lastError: "HTTP 503",
      attemptLog: [{ statusCode: 503, ok: false, responseBody: "busy" }],
    })

    const one = await deliveryRoute.GET(
      req(`/api/webhooks/deliveries/${delivery.id}`),
      params({ id: delivery.id })
    )
    expect((await one.json()).data.payload.data.item.payload).toEqual({
      hello: "world",
    })

    const all = await allDeliveriesRoute.GET(
      req(`/api/webhooks/deliveries?webhookId=${webhook.id}&status=dead`)
    )
    expect((await all.json()).page.total).toBe(0)
    const badStatus = await allDeliveriesRoute.GET(
      req(`/api/webhooks/deliveries?status=nope`)
    )
    expect(badStatus.status).toBe(400)

    const retried = await deliveryRetryRoute.POST(
      req(`/api/webhooks/deliveries/${delivery.id}/retry`, { method: "POST" }),
      params({ id: delivery.id })
    )
    expect((await retried.json()).data).toMatchObject({
      status: "pending",
      attempts: 0,
    })

    // The secret never lands in the outbox file.
    const file = await readFile(
      path.join(dataDir, "webhook-deliveries.json"),
      "utf8"
    )
    expect(file).not.toContain(secret)
  })

  it("is admin only (access:manage)", async () => {
    const list = await webhooksRoute.GET(
      req("/api/webhooks", { key: OPERATOR })
    )
    expect(list.status).toBe(403)
    const create = await webhooksRoute.POST(
      req("/api/webhooks", {
        key: OPERATOR,
        method: "POST",
        body: json({ name: "x", url: "https://x.example.com" }),
      })
    )
    expect(create.status).toBe(403)
    const deliveries = await allDeliveriesRoute.GET(
      req("/api/webhooks/deliveries", { key: OPERATOR })
    )
    expect(deliveries.status).toBe(403)
  })
})

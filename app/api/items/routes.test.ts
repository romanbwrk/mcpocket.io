import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetStorageSingleton } from "@mcpocket/core/storage"

import * as foldersRoute from "../folders/route"
import * as tubeItemsRoute from "../tubes/[id]/items/route"
import * as tubesRoute from "../tubes/route"
import * as historyRoute from "./[id]/history/route"
import * as reassignRoute from "./[id]/reassign/route"
import * as itemRoute from "./[id]/route"

const SECRET = "test-secret-123"
let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-item-routes-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_API_KEYS", `ci:${SECRET}`)
  await resetStorageSingleton()
})
afterEach(async () => {
  await resetStorageSingleton()
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

const req = (
  url: string,
  init: RequestInit & { key?: string | null; agent?: string } = {}
) => {
  const { key = SECRET, agent, ...rest } = init
  const headers = new Headers(rest.headers)
  if (key) headers.set("authorization", `Bearer ${key}`)
  if (agent) headers.set("x-agent-id", agent)
  if (rest.body) headers.set("content-type", "application/json")
  return new Request(`http://localhost${url}`, { ...rest, headers })
}
const json = (method: string, body: unknown) => ({
  method,
  body: JSON.stringify(body),
})
const params = <P>(p: P) => ({ params: Promise.resolve(p) })

async function createTube(body: Record<string, unknown> = {}) {
  let res = await foldersRoute.POST(
    req("/api/folders", json("POST", { name: "F" }))
  )
  const folder = (await res.json()).data
  res = await tubesRoute.POST(
    req("/api/tubes", json("POST", { folderId: folder.id, name: "T", ...body }))
  )
  return (await res.json()).data as { id: string }
}

const push = (tubeId: string, body: unknown, agent?: string) =>
  tubeItemsRoute.POST(
    req(`/api/tubes/${tubeId}/items`, { ...json("POST", body), agent }),
    params({ id: tubeId })
  )

describe("item REST routes", () => {
  it("requires auth", async () => {
    const id = crypto.randomUUID()
    const res = await itemRoute.GET(
      req(`/api/items/${id}`, { key: null }),
      params({ id })
    )
    expect(res.status).toBe(401)
  })

  it("pushes (idempotently), lists, reads, updates, deletes and audits items", async () => {
    const tube = await createTube({
      schemaDefinition: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    })

    // schema violation → 400 with details
    let res = await push(tube.id, { payload: { nope: 1 } })
    expect(res.status).toBe(400)
    const err = await res.json()
    expect(err.error.code).toBe("validation_error")
    expect(err.error.details[0]).toMatchObject({ keyword: "required" })

    res = await push(
      tube.id,
      { payload: { url: "https://a" }, idempotencyKey: "k", tags: ["web"] },
      "bot-1"
    )
    expect(res.status).toBe(201)
    const item = (await res.json()).data
    expect(item).toMatchObject({
      status: "pending",
      tags: ["web"],
      priority: 0,
    })

    // repeat → 200 with the original item
    res = await push(tube.id, {
      payload: { url: "https://other" },
      idempotencyKey: "k",
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.id).toBe(item.id)

    res = await push(tube.id, { payload: { url: "https://b" } })
    const second = (await res.json()).data

    res = await tubeItemsRoute.GET(
      req(`/api/tubes/${tube.id}/items?limit=1&offset=1`),
      params({ id: tube.id })
    )
    let body = await res.json()
    expect(body.page).toEqual({ offset: 1, limit: 1, total: 2 })
    expect(body.data.map((i: { id: string }) => i.id)).toEqual([second.id])

    // PATCH: fields + status; invalid transition → 409
    res = await itemRoute.PATCH(
      req(`/api/items/${item.id}`, {
        ...json("PATCH", { priority: 3, status: "cancelled" }),
      }),
      params({ id: item.id })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({
      priority: 3,
      status: "cancelled",
    })
    res = await itemRoute.PATCH(
      req(`/api/items/${item.id}`, json("PATCH", { status: "completed" })),
      params({ id: item.id })
    )
    expect(res.status).toBe(409)
    res = await itemRoute.PATCH(
      req(`/api/items/${item.id}`, json("PATCH", { bogus: 1 })),
      params({ id: item.id })
    )
    expect(res.status).toBe(400)

    // soft delete
    res = await itemRoute.DELETE(
      req(`/api/items/${item.id}`, { method: "DELETE" }),
      params({ id: item.id })
    )
    expect(res.status).toBe(204)
    res = await tubeItemsRoute.GET(
      req(`/api/tubes/${tube.id}/items`),
      params({ id: tube.id })
    )
    body = await res.json()
    expect(body.data.map((i: { id: string }) => i.id)).toEqual([second.id])
    res = await tubeItemsRoute.GET(
      req(`/api/tubes/${tube.id}/items?includeDeleted=true`),
      params({ id: tube.id })
    )
    expect((await res.json()).page.total).toBe(2)
    res = await itemRoute.GET(
      req(`/api/items/${item.id}`),
      params({ id: item.id })
    )
    expect((await res.json()).data.deletedAt).toBeTruthy()

    // history newest first, with actors
    res = await historyRoute.GET(
      req(`/api/items/${item.id}/history`),
      params({ id: item.id })
    )
    body = await res.json()
    expect(body.data.map((e: { action: string }) => e.action)).toEqual([
      "deleted",
      "status_changed",
      "updated",
      "created",
    ])
    expect(body.data.at(-1).actor).toBe("agent:bot-1")
    expect(body.data[0].actor).toBe("api_key:ci")
    expect(body.page.total).toBe(4)
  })

  it("rejects pushes to disabled tubes (409) and unknown ids (404)", async () => {
    const tube = await createTube({ enabled: false })
    let res = await push(tube.id, { payload: {} })
    expect(res.status).toBe(409)
    const id = crypto.randomUUID()
    res = await push(id, { payload: {} })
    expect(res.status).toBe(404)
    res = await historyRoute.GET(
      req(`/api/items/${id}/history`),
      params({ id })
    )
    expect(res.status).toBe(404)
  })
  it("reassigns an item's agent", async () => {
    const tube = await createTube()
    const item = (await (await push(tube.id, { payload: {} })).json()).data
    let res = await reassignRoute.POST(
      req(`/api/items/${item.id}/reassign`, json("POST", { agentId: "bot-7" })),
      params({ id: item.id })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data.assignedAgent).toBe("bot-7")
    res = await reassignRoute.POST(
      req(`/api/items/${item.id}/reassign`, json("POST", { agent: "x" })),
      params({ id: item.id })
    )
    expect(res.status).toBe(400)
    res = await historyRoute.GET(
      req(`/api/items/${item.id}/history`),
      params({ id: item.id })
    )
    expect((await res.json()).data[0]).toMatchObject({
      action: "reassigned",
      newValue: { assignedAgent: "bot-7" },
    })
  })
})

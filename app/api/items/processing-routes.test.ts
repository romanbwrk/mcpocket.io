import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetStorageSingleton } from "@mcpocket/core/storage"

import * as agentItemsRoute from "../agents/[id]/items/route"
import * as foldersRoute from "../folders/route"
import * as tubeItemsRoute from "../tubes/[id]/items/route"
import * as tubesRoute from "../tubes/route"
import * as completeRoute from "./[id]/complete/route"
import * as failRoute from "./[id]/fail/route"
import * as heartbeatRoute from "./[id]/heartbeat/route"
import * as historyRoute from "./[id]/history/route"
import * as releaseRoute from "./[id]/release/route"
import * as claimRoute from "./claim/route"

const SECRET = "test-secret-123"
let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-processing-routes-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_API_KEYS", `ci:${SECRET}`)
  vi.stubEnv("MCPOCKET_LEASE_SECONDS", "120")
  // 2nd failed attempt is final (retry policy from env)
  vi.stubEnv("MCPOCKET_RETRY_MAX_ATTEMPTS", "2")
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
const post = (url: string, body: unknown, agent?: string) =>
  req(url, { method: "POST", body: JSON.stringify(body), agent })
const params = <P>(p: P) => ({ params: Promise.resolve(p) })

async function createTube() {
  let res = await foldersRoute.POST(post("/api/folders", { name: "F" }))
  const folder = (await res.json()).data
  res = await tubesRoute.POST(
    post("/api/tubes", { folderId: folder.id, name: "T" })
  )
  return (await res.json()).data as { id: string }
}

async function pushItem(tubeId: string, priority = 0) {
  const res = await tubeItemsRoute.POST(
    post(`/api/tubes/${tubeId}/items`, { payload: { p: priority }, priority }),
    params({ id: tubeId })
  )
  return (await res.json()).data as { id: string }
}

const claim = (tubeId: string, agent?: string) =>
  claimRoute.POST(post("/api/items/claim", { tubeId }, agent))

const act = (
  route: { POST: typeof completeRoute.POST },
  name: string,
  id: string,
  body: unknown,
  agent?: string
) => route.POST(post(`/api/items/${id}/${name}`, body, agent), params({ id }))

describe("processing REST routes", () => {
  it("requires auth and an agent identity", async () => {
    const tube = await createTube()
    let res = await claimRoute.POST(
      req("/api/items/claim", {
        method: "POST",
        body: JSON.stringify({ tubeId: tube.id }),
        key: null,
      })
    )
    expect(res.status).toBe(401)
    res = await claim(tube.id)
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toMatch(/X-Agent-Id/)
  })

  it("runs the claim → heartbeat → complete loop with audit history", async () => {
    const tube = await createTube()
    const low = await pushItem(tube.id, 0)
    const high = await pushItem(tube.id, 5)

    let res = await claim(tube.id, "bot-1")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.claimed).toBe(true)
    expect(body.data).toMatchObject({
      id: high.id,
      status: "processing",
      assignedAgent: "bot-1",
      attempts: 1,
    })
    expect(body.claim).toMatchObject({
      itemId: high.id,
      agentId: "bot-1",
      attempts: 1,
      leaseExpiresAt: body.data.leaseExpiresAt,
    })
    expect(
      Date.parse(body.claim.leaseExpiresAt) - Date.parse(body.claim.claimedAt)
    ).toBe(120_000)

    res = await act(heartbeatRoute, "heartbeat", high.id, {}, "bot-2")
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe("forbidden")

    res = await act(heartbeatRoute, "heartbeat", high.id, {}, "bot-1")
    expect(res.status).toBe(200)

    res = await act(
      completeRoute,
      "complete",
      high.id,
      { result: { ok: true } },
      "bot-1"
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({
      status: "completed",
      result: { ok: true },
      completedAt: expect.any(String),
    })

    res = await act(completeRoute, "complete", high.id, {}, "bot-1")
    expect(res.status).toBe(409)

    res = await historyRoute.GET(
      req(`/api/items/${high.id}/history`),
      params({ id: high.id })
    )
    const actions = (await res.json()).data.map(
      (e: { action: string; actor: string }) => [e.action, e.actor]
    )
    expect(actions).toEqual([
      ["completed", "agent:bot-1"],
      ["heartbeat", "agent:bot-1"],
      ["claimed", "agent:bot-1"],
      ["created", "api_key:ci"],
    ])

    // fail + release on the remaining item
    res = await claim(tube.id, "bot-2")
    expect((await res.json()).data.id).toBe(low.id)
    res = await act(releaseRoute, "release", low.id, {}, "bot-2")
    expect((await res.json()).data).toMatchObject({
      status: "pending",
      assignedAgent: null,
    })
    await claim(tube.id, "bot-2")
    res = await act(failRoute, "fail", low.id, { error: "boom" }, "bot-2")
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({
      status: "failed",
      attempts: 2,
      lastError: { message: "boom", agentId: "bot-2" },
    })
    res = await act(failRoute, "fail", low.id, { error: "again" }, "bot-2")
    expect(res.status).toBe(409) // not processing any more

    // nothing to claim
    res = await claim(tube.id, "bot-1")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      claimed: false,
      data: null,
      message: "Nothing to claim",
    })

    // agent items
    res = await agentItemsRoute.GET(
      req("/api/agents/bot-2/items?status=failed"),
      params({ id: "bot-2" })
    )
    const agentItems = await res.json()
    expect(agentItems.data.map((i: { id: string }) => i.id)).toEqual([low.id])
    expect(agentItems.page.total).toBe(1)
  })

  it("validates claim input", async () => {
    let res = await claimRoute.POST(post("/api/items/claim", {}, "bot-1"))
    expect(res.status).toBe(400)
    res = await claim(crypto.randomUUID(), "bot-1")
    expect(res.status).toBe(404)
  })

  it("parallel HTTP claimers never get the same item", async () => {
    const tube = await createTube()
    const M = 15
    for (let i = 0; i < M; i++) await pushItem(tube.id, i % 4)
    const responses = await Promise.all(
      Array.from({ length: M + 10 }, (_, i) =>
        claim(tube.id, `agent-${i % 5}`).then((r) => r.json())
      )
    )
    const ids = responses.filter((b) => b.claimed).map((b) => b.data.id)
    expect(ids).toHaveLength(M)
    expect(new Set(ids).size).toBe(M)
    expect(responses.filter((b) => !b.claimed)).toHaveLength(10)
  })
})

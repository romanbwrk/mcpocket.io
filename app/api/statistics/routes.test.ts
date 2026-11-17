import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createMcpServer } from "@mcpocket/core/mcp/server"
import { getServices } from "@mcpocket/core/services"
import { resetStorageSingleton } from "@mcpocket/core/storage"

import * as foldersRoute from "../folders/route"
import * as claimRoute from "../items/claim/route"
import * as failRoute from "../items/[id]/fail/route"
import * as tubeItemsRoute from "../tubes/[id]/items/route"
import * as tubeStatsAliasRoute from "../tubes/[id]/statistics/route"
import * as tubesRoute from "../tubes/route"
import * as agentsRoute from "./agents/route"
import * as errorsRoute from "./errors/route"
import * as globalRoute from "./route"
import * as tubeStatsRoute from "./tubes/[id]/route"

const SECRET = "test-secret-123"
const MISSING = "00000000-0000-4000-8000-000000000000"
let dataDir: string
let client: Client | undefined

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-stats-routes-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_API_KEYS", `ci:${SECRET}`)
  vi.stubEnv("MCPOCKET_RETRY_MAX_ATTEMPTS", "1") // fail is final
  await resetStorageSingleton()
})
afterEach(async () => {
  await client?.close()
  client = undefined
  await resetStorageSingleton()
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

const req = (url: string, init: RequestInit & { agent?: string } = {}) => {
  const { agent, ...rest } = init
  const headers = new Headers(rest.headers)
  headers.set("authorization", `Bearer ${SECRET}`)
  if (agent) headers.set("x-agent-id", agent)
  if (rest.body) headers.set("content-type", "application/json")
  return new Request(`http://localhost${url}`, { ...rest, headers })
}
const post = (url: string, body: unknown, agent?: string) =>
  req(url, { method: "POST", body: JSON.stringify(body), agent })
const params = <P>(p: P) => ({ params: Promise.resolve(p) })

async function setup() {
  let res = await foldersRoute.POST(post("/api/folders", { name: "F" }))
  const folder = (await res.json()).data
  res = await tubesRoute.POST(
    post("/api/tubes", { folderId: folder.id, name: "T" })
  )
  const tube = (await res.json()).data as { id: string }
  for (const n of [1, 2, 3]) {
    await tubeItemsRoute.POST(
      post(`/api/tubes/${tube.id}/items`, { payload: { n } }),
      params({ id: tube.id })
    )
  }
  res = await claimRoute.POST(
    post("/api/items/claim", { tubeId: tube.id }, "bot-1")
  )
  const claimed = (await res.json()).data as { id: string }
  await failRoute.POST(
    post(`/api/items/${claimed.id}/fail`, { error: "boom" }, "bot-1"),
    params({ id: claimed.id })
  )
  await claimRoute.POST(post("/api/items/claim", { tubeId: tube.id }, "bot-2"))
  return { tube, failedId: claimed.id }
}

async function mcp(name: string, args: Record<string, unknown> = {}) {
  if (!client) {
    const server = createMcpServer({
      services: () => getServices({ kind: "api_key", id: "ci" }),
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)
  }
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as CallToolResult
  return {
    isError: result.isError === true,
    body: JSON.parse((result.content[0] as { text: string }).text),
  }
}

const withoutGeneratedAt = (body: { data: Record<string, unknown> }) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { generatedAt, ...rest } = body.data
  return rest
}

describe("statistics REST", () => {
  it("GET /api/statistics returns global counts", async () => {
    await setup()
    const res = await globalRoute.GET(req("/api/statistics"))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({
      counts: { total: 3, pending: 1, processing: 1, failed: 1 },
      folders: 1,
      tubes: 1,
      agents: 2,
    })
  })

  it("tube statistics via both paths; 404 / 400", async () => {
    const { tube } = await setup()
    const a = await tubeStatsRoute.GET(
      req(`/api/statistics/tubes/${tube.id}`),
      params({ id: tube.id })
    )
    const b = await tubeStatsAliasRoute.GET(
      req(`/api/tubes/${tube.id}/statistics`),
      params({ id: tube.id })
    )
    expect(a.status).toBe(200)
    const bodyA = await a.json()
    expect(bodyA.data.counts).toMatchObject({ total: 3, failed: 1 })
    expect(withoutGeneratedAt(await b.json())).toEqual(
      withoutGeneratedAt(bodyA)
    )
    const missing = await tubeStatsRoute.GET(
      req(`/api/statistics/tubes/${MISSING}`),
      params({ id: MISSING })
    )
    expect(missing.status).toBe(404)
    const bad = await tubeStatsAliasRoute.GET(
      req("/api/tubes/x/statistics"),
      params({ id: "x" })
    )
    expect(bad.status).toBe(400)
  })

  it("GET /api/statistics/agents and /errors with filters", async () => {
    const { tube, failedId } = await setup()
    let res = await agentsRoute.GET(req("/api/statistics/agents?limit=1"))
    let body = await res.json()
    expect(body.page).toEqual({ offset: 0, limit: 1, total: 2 })
    expect(body.data[0]).toMatchObject({ agentId: "bot-2", processing: 1 })

    res = await errorsRoute.GET(
      req(`/api/statistics/errors?tubeId=${tube.id}&status=failed,retry`)
    )
    body = await res.json()
    expect(body.data).toEqual([
      expect.objectContaining({
        itemId: failedId,
        error: expect.objectContaining({ message: "boom", agentId: "bot-1" }),
      }),
    ])
    res = await errorsRoute.GET(req("/api/statistics/errors?limit=0"))
    expect(res.status).toBe(400)
  })
})

describe("statistics MCP tools", () => {
  it("return the same shapes as REST", async () => {
    const { tube } = await setup()

    const global = await mcp("get_statistics")
    expect(global.isError).toBe(false)
    expect(withoutGeneratedAt(global.body)).toEqual(
      withoutGeneratedAt(
        await (await globalRoute.GET(req("/api/statistics"))).json()
      )
    )

    const tubeStats = await mcp("get_tube_statistics", { id: tube.id })
    const restTube = await tubeStatsRoute.GET(
      req(`/api/statistics/tubes/${tube.id}`),
      params({ id: tube.id })
    )
    expect(withoutGeneratedAt(tubeStats.body)).toEqual(
      withoutGeneratedAt(await restTube.json())
    )

    const agents = await mcp("get_agent_statistics", { agentId: "bot-1" })
    expect(agents.body).toEqual(
      await (
        await agentsRoute.GET(req("/api/statistics/agents?agentId=bot-1"))
      ).json()
    )

    const errors = await mcp("get_processing_errors", {
      tubeId: tube.id,
      limit: 10,
    })
    expect(errors.body).toEqual(
      await (
        await errorsRoute.GET(
          req(`/api/statistics/errors?tubeId=${tube.id}&limit=10`)
        )
      ).json()
    )
    expect(errors.body.data).toHaveLength(1)

    const missing = await mcp("get_tube_statistics", { id: MISSING })
    expect(missing.isError).toBe(true)
    expect(missing.body.error.code).toBe("not_found")
  })
})

import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { z } from "zod"

import * as messagesRoute from "@/app/api/mcp/messages/route"
import * as mcpRoute from "@/app/api/mcp/route"
import * as sseRoute from "@/app/api/mcp/sse/route"
import * as folderMcpRoute from "@/app/api/mcp/folders/[folderId]/route"
import * as tubeMcpRoute from "@/app/api/mcp/tubes/[tubeId]/route"
import { resetStorageSingleton } from "@mcpocket/core/storage"

import { handleStreamableHttp } from "@mcpocket/core/mcp/http"
import { legacySseSessionCount, openLegacySseSession } from "@mcpocket/core/mcp/sse"
import { defineTool, mcpTools } from "@mcpocket/core/mcp/tools"
import {
  resolveConnectionScope,
  TUBE_SCOPED_HIDDEN_TOOLS,
} from "@mcpocket/core/mcp/connection-scope"

/**
 * Exercises every transport over real HTTP: the Next route handlers are
 * mounted on a plain Node server, and real SDK clients connect to it
 * (Streamable HTTP, legacy SSE, and the stdio proxy as a child process).
 */
const SECRET = "transport-secret"
const OTHER = "other-secret"
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const whoami = defineTool({
  name: "whoami",
  description: "test-only",
  input: z.object({}),
  run: async (services) => ({ actor: services.actor }),
})
type Handler = (request: Request) => Promise<Response>
const routes: Record<string, Record<string, Handler>> = {
  "/api/mcp": mcpRoute,
  "/api/mcp/sse": sseRoute,
  "/api/mcp/messages": messagesRoute,
  // test-only endpoints exposing the `whoami` tool
  "/test/mcp": { POST: (r) => handleStreamableHttp(r, { tools: [whoami] }) },
  "/test/sse": { GET: (r) => openLegacySseSession(r, { tools: [whoami] }) },
}

let dataDir: string
let server: Server
let baseUrl: string

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-transports-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_API_KEYS", `ci:${SECRET},other:${OTHER}`)
  await resetStorageSingleton()

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
    const tubeRoute = /^\/api\/mcp\/tubes\/([^/]+)$/.exec(url.pathname)
    const folderRoute = /^\/api\/mcp\/folders\/([^/]+)$/.exec(url.pathname)
    const handler: Handler | undefined =
      tubeRoute && req.method === "POST"
        ? (r) =>
            tubeMcpRoute.POST(r, {
              params: Promise.resolve({ tubeId: tubeRoute[1] }),
            })
        : folderRoute && req.method === "POST"
          ? (r) =>
              folderMcpRoute.POST(r, {
                params: Promise.resolve({ folderId: folderRoute[1] }),
              })
          : routes[url.pathname]?.[req.method ?? "GET"]
    if (!handler) return void res.writeHead(404).end()
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      for (const value of [v ?? []].flat()) headers.append(k, value)
    }
    const abort = new AbortController()
    res.on("close", () => abort.abort())
    const response = await handler(
      new Request(url, {
        method: req.method,
        headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
        signal: abort.signal,
      })
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (!response.body) return void res.end()
    const reader = response.body.getReader()
    res.on("close", () => void reader.cancel().catch(() => {}))
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    } catch {
      // client went away
    }
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await resetStorageSingleton()
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
})

async function connect(transport: Transport) {
  const client = new Client({ name: "transport-test", version: "1.0.0" })
  await client.connect(transport)
  clients.push(client)
  return client
}
const authHeaders = (secret = SECRET, extra: Record<string, string> = {}) => ({
  requestInit: { headers: { authorization: `Bearer ${secret}`, ...extra } },
})
async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
) {
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as CallToolResult
  return {
    isError: result.isError === true,
    body: JSON.parse((result.content[0] as { text: string }).text),
  }
}

describe("Streamable HTTP transport (/api/mcp)", () => {
  it("rejects requests without a valid API key (401 JSON error)", async () => {
    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong" },
    ]
    for (const headers of attempts) {
      const res = await fetch(`${baseUrl}/api/mcp`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
      expect(res.status).toBe(401)
      expect(res.headers.get("www-authenticate")).toMatch(/Bearer/)
      expect((await res.json()).error.code).toBe("unauthorized")
    }
    const client = new Client({ name: "t", version: "1" })
    await expect(
      client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`))
      )
    ).rejects.toThrow()
  })

  it("serves the tools with the API key", async () => {
    const client = await connect(
      new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/api/mcp`),
        authHeaders()
      )
    )
    expect(client.getServerVersion()?.name).toBe("mcpocket")
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      mcpTools.map((t) => t.name).sort()
    )
    const created = await callJson(client, "create_folder", { name: "http" })
    expect(created.isError).toBe(false)
    const tree = await callJson(client, "get_folder_tree")
    expect(tree.body.data.map((f: { name: string }) => f.name)).toContain(
      "http"
    )
    const bad = await callJson(client, "create_tube", { name: "" })
    expect(bad).toMatchObject({
      isError: true,
      body: { error: { code: "validation_error" } },
    })
  })

  it("passes the API key / agent identity to the services", async () => {
    const asKey = await connect(
      new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/test/mcp`),
        authHeaders()
      )
    )
    expect((await callJson(asKey, "whoami")).body.actor).toEqual({
      kind: "api_key",
      id: "ci",
      // env keys without a configured role keep full access (backward compatible)
      access: { role: "admin", scope: null },
    })
    const asAgent = await connect(
      new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/test/mcp`),
        authHeaders(OTHER, { "x-agent-id": "bot-7" })
      )
    )
    expect((await callJson(asAgent, "whoami")).body.actor).toEqual({
      kind: "agent",
      id: "bot-7",
      viaKeyId: "other",
      access: { role: "admin", scope: null },
    })
  })
})

describe("legacy HTTP+SSE transport (/api/mcp/sse)", () => {
  it("rejects opening a stream without a valid API key", async () => {
    const res = await fetch(`${baseUrl}/api/mcp/sse`)
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe("unauthorized")
  })

  it("serves the tools and binds the session actor", async () => {
    const client = await connect(
      new SSEClientTransport(new URL(`${baseUrl}/api/mcp/sse`), authHeaders())
    )
    expect(client.getServerVersion()?.name).toBe("mcpocket")
    const created = await callJson(client, "create_folder", { name: "sse" })
    expect(created.body.data.name).toBe("sse")
    const list = await callJson(client, "list_folders", { parentId: null })
    expect(list.body.data.map((f: { name: string }) => f.name)).toContain("sse")

    const agent = await connect(
      new SSEClientTransport(
        new URL(`${baseUrl}/test/sse`),
        authHeaders(SECRET, { "x-agent-id": "sse-bot" })
      )
    )
    expect((await callJson(agent, "whoami")).body.actor).toEqual({
      kind: "agent",
      id: "sse-bot",
      viaKeyId: "ci",
      access: { role: "admin", scope: null },
    })
  })

  it("requires the session's API key on posted messages", async () => {
    const transport = new SSEClientTransport(
      new URL(`${baseUrl}/api/mcp/sse`),
      authHeaders()
    )
    await connect(transport)
    const sessionId = (
      transport as unknown as { _endpoint: URL }
    )._endpoint.searchParams.get("sessionId")
    expect(sessionId).toBeTruthy()
    const post = (headers: Record<string, string>) =>
      fetch(`${baseUrl}/api/mcp/messages?sessionId=${sessionId}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }),
      })
    expect((await post({})).status).toBe(401)
    expect((await post({ authorization: `Bearer ${OTHER}` })).status).toBe(403)
    expect((await post({ authorization: `Bearer ${SECRET}` })).status).toBe(202)
    const unknown = await fetch(`${baseUrl}/api/mcp/messages?sessionId=nope`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      body: "{}",
    })
    expect(unknown.status).toBe(404)
  })

  it("drops the session when the client disconnects", async () => {
    // sessions of earlier tests close asynchronously after their clients
    await vi.waitFor(() => expect(legacySseSessionCount()).toBe(0))
    const client = await connect(
      new SSEClientTransport(new URL(`${baseUrl}/api/mcp/sse`), authHeaders())
    )
    expect(legacySseSessionCount()).toBe(1)
    await client.close()
    await vi.waitFor(() => expect(legacySseSessionCount()).toBe(0))
  })
})

describe("stdio transport (bin/mcpocket-stdio.mjs → /api/mcp)", () => {
  const stdio = (env: Record<string, string>) =>
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "bin/mcpocket-stdio.mjs")],
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", ...env },
      stderr: "pipe",
    })

  it("proxies tools to the running app with the API key", async () => {
    const client = await connect(
      stdio({ MCPOCKET_URL: baseUrl, MCPOCKET_API_KEY: SECRET })
    )
    expect(client.getServerVersion()?.name).toBe("mcpocket")
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain("create_tube")
    const { body: folder } = await callJson(client, "create_folder", {
      name: "stdio",
    })
    const { body: tube } = await callJson(client, "create_tube", {
      folderId: folder.data.id,
      name: "stdio-tube",
    })
    expect(tube.data.folderId).toBe(folder.data.id)
    const bad = await callJson(client, "delete_folder", { id: folder.data.id })
    expect(bad).toMatchObject({
      isError: true,
      body: { error: { code: "conflict" } },
    })
  })

  it("surfaces a rejected API key as an error", async () => {
    const client = new Client({ name: "t", version: "1" })
    await expect(
      client.connect(stdio({ MCPOCKET_URL: baseUrl, MCPOCKET_API_KEY: "bad" }))
    ).rejects.toThrow(/401|Unauthorized|rejected/i)
    await client.close()
  })
})

describe("tube-scoped connections", () => {
  async function setup() {
    const admin = await connect(
      new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/api/mcp`),
        authHeaders()
      )
    )
    const { body: folder } = await callJson(admin, "create_folder", {
      name: "scoped",
    })
    const { body: mine } = await callJson(admin, "create_tube", {
      folderId: folder.data.id,
      name: "mine",
    })
    const { body: other } = await callJson(admin, "create_tube", {
      folderId: folder.data.id,
      name: "other",
    })
    return { mine: mine.data.id as string, other: other.data.id as string }
  }

  it("HTTP: only the tube, tubeId defaults to it, structure tools hidden", async () => {
    const { mine, other } = await setup()
    const client = await connect(
      new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/api/mcp/tubes/${mine}`),
        authHeaders(SECRET, { "x-agent-id": "tube-bot" })
      )
    )
    expect(client.getInstructions()).toContain(`id ${mine}`)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain("claim_next_item")
    for (const hidden of TUBE_SCOPED_HIDDEN_TOOLS) {
      expect(names).not.toContain(hidden)
    }

    const pushed = await callJson(client, "push_item", { payload: { n: 1 } })
    expect(pushed.isError, JSON.stringify(pushed.body)).toBe(false)
    expect(pushed.body.data.tubeId).toBe(mine)
    const claim = await callJson(client, "claim_next_item", {})
    expect(claim.body).toMatchObject({ claimed: true, data: { tubeId: mine } })

    const tubes = await callJson(client, "list_tubes")
    expect(tubes.body.data.map((t: { id: string }) => t.id)).toEqual([mine])
    const foreign = await callJson(client, "push_item", {
      tubeId: other,
      payload: {},
    })
    expect(foreign).toMatchObject({
      isError: true,
      body: { error: { code: "not_found" } },
    })
  })

  it("HTTP: unknown tube → 404", async () => {
    const res = await fetch(
      `${baseUrl}/api/mcp/tubes/00000000-0000-4000-8000-000000000000`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }
    )
    expect(res.status).toBe(404)
  })

  it("legacy SSE ?tubeId= stays bound to the tube across messages", async () => {
    const { mine } = await setup()
    const client = await connect(
      new SSEClientTransport(
        new URL(`${baseUrl}/api/mcp/sse?tubeId=${mine}`),
        authHeaders()
      )
    )
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain("create_folder")
    const tubes = await callJson(client, "list_tubes")
    expect(tubes.body.data.map((t: { id: string }) => t.id)).toEqual([mine])
  })

  it("stdio: MCPOCKET_TUBE_ID proxies to the tube endpoint", async () => {
    const { mine } = await setup()
    const client = await connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(ROOT, "bin/mcpocket-stdio.mjs")],
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          MCPOCKET_URL: baseUrl,
          MCPOCKET_API_KEY: SECRET,
          MCPOCKET_TUBE_ID: mine,
        },
        stderr: "pipe",
      })
    )
    const pushed = await callJson(client, "push_item", { payload: {} })
    expect(pushed.body.data.tubeId).toBe(mine)
  })
})

describe("folder-scoped connections", () => {
  async function setup() {
    const admin = await connect(
      new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/api/mcp`),
        authHeaders()
      )
    )
    const create = async (name: string, parentId: string | null = null) =>
      (await callJson(admin, "create_folder", { name, parentId })).body.data
        .id as string
    const bound = await create("bound")
    const child = await create("bound-child", bound)
    const outside = await create("outside")
    const tube = async (name: string, folderId: string) =>
      (await callJson(admin, "create_tube", { name, folderId })).body.data
        .id as string
    return {
      bound,
      child,
      inner: await tube("inner", child),
      outer: await tube("outer", outside),
    }
  }
  const folderClient = (folderId: string) =>
    connect(
      new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/api/mcp/folders/${folderId}`),
        authHeaders()
      )
    )

  it("HTTP: only the subtree; new folders/tubes default into it", async () => {
    const { bound, child, inner, outer } = await setup()
    const client = await folderClient(bound)
    expect(client.getInstructions()).toContain(`folder "bound"`)

    const tubes = await callJson(client, "list_tubes")
    expect(tubes.body.data.map((t: { id: string }) => t.id)).toEqual([inner])
    const foreign = await callJson(client, "push_item", {
      tubeId: outer,
      payload: {},
    })
    expect(foreign.body.error.code).toBe("not_found")
    expect(
      (await callJson(client, "push_item", { tubeId: inner, payload: {} }))
        .isError
    ).toBe(false)

    const folder = await callJson(client, "create_folder", { name: "sub" })
    expect(folder.body.data.parentId).toBe(bound)
    const tube = await callJson(client, "create_tube", { name: "new" })
    expect(tube.body.data.folderId).toBe(bound)
    const root = await callJson(client, "create_tube", {
      name: "root",
      folderId: null,
    })
    expect(root.body.error.code).toBe("forbidden")

    for (const [name, args] of [
      ["delete_folder", { id: bound }],
      ["move_folder", { id: bound, parentId: null }],
      ["update_folder", { id: bound, parentId: null }],
    ] as const) {
      const result = await callJson(client, name, args)
      expect(result.body.error.code, name).toBe("forbidden")
    }
    const renamed = await callJson(client, "update_folder", {
      id: bound,
      description: "ok",
    })
    expect(renamed.isError).toBe(false)
    const moved = await callJson(client, "move_folder", {
      id: child,
      parentId: folder.body.data.id,
    })
    expect(moved.isError).toBe(false)
  })

  it("cannot widen a scoped key's access", async () => {
    const { bound, child } = await setup()
    const scopedActor = {
      kind: "api_key" as const,
      id: "scoped",
      access: {
        role: "operator" as const,
        scope: { folderIds: [child], tubeIds: [] },
      },
    }
    // the parent is visible to the key (ancestor) but not accessible
    await expect(
      resolveConnectionScope(scopedActor, { kind: "folder", id: bound })
    ).rejects.toMatchObject({ code: "forbidden" })
    const ok = await resolveConnectionScope(scopedActor, {
      kind: "folder",
      id: child,
    })
    expect(ok.actor.access?.scope).toEqual({ folderIds: [child], tubeIds: [] })
  })

  it("legacy SSE ?folderId= and stdio MCPOCKET_FOLDER_ID", async () => {
    const { bound, inner } = await setup()
    const sse = await connect(
      new SSEClientTransport(
        new URL(`${baseUrl}/api/mcp/sse?folderId=${bound}`),
        authHeaders()
      )
    )
    const viaSse = await callJson(sse, "list_tubes")
    expect(viaSse.body.data.map((t: { id: string }) => t.id)).toEqual([inner])

    const stdio = await connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(ROOT, "bin/mcpocket-stdio.mjs")],
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          MCPOCKET_URL: baseUrl,
          MCPOCKET_API_KEY: SECRET,
          MCPOCKET_FOLDER_ID: bound,
        },
        stderr: "pipe",
      })
    )
    const viaStdio = await callJson(stdio, "list_tubes")
    expect(viaStdio.body.data.map((t: { id: string }) => t.id)).toEqual([inner])
  })
})

describe("end-to-end: two MCP agents share one tube", () => {
  it("claims concurrently, completes distinct items, history shows both agents", async () => {
    const producer = await connect(
      new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/api/mcp`),
        authHeaders()
      )
    )
    const { body: folder } = await callJson(producer, "create_folder", {
      name: "e2e",
    })
    const { body: tube } = await callJson(producer, "create_tube", {
      folderId: folder.data.id,
      name: "e2e-jobs",
    })
    const tubeId = tube.data.id
    const total = 12
    await Promise.all(
      Array.from({ length: total }, (_, n) =>
        callJson(producer, "push_item", { tubeId, payload: { n } })
      )
    )

    // agent A over Streamable HTTP, agent B over legacy SSE
    const agentA = await connect(
      new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/api/mcp`),
        authHeaders(SECRET, { "x-agent-id": "agent-a" })
      )
    )
    const agentB = await connect(
      new SSEClientTransport(
        new URL(`${baseUrl}/api/mcp/sse`),
        authHeaders(OTHER, { "x-agent-id": "agent-b" })
      )
    )

    async function work(client: Client, agentId: string, first: string) {
      const done: string[] = []
      let next: string | null = first
      while (next) {
        await callJson(client, "heartbeat_item", { id: next })
        const completed = await callJson(client, "complete_item", {
          id: next,
          result: { by: agentId },
        })
        expect(completed.isError, JSON.stringify(completed.body)).toBe(false)
        done.push(next)
        const claim = await callJson(client, "claim_next_item", { tubeId })
        expect(claim.isError).toBe(false)
        if (claim.body.claimed) expect(claim.body.claim.agentId).toBe(agentId)
        next = claim.body.claimed ? claim.body.data.id : null
      }
      return done
    }

    // both claim at the same moment: they must get different items
    const [a1, b1] = await Promise.all([
      callJson(agentA, "claim_next_item", { tubeId }),
      callJson(agentB, "claim_next_item", { tubeId }),
    ])
    expect(a1.body.claimed && b1.body.claimed).toBe(true)
    expect(a1.body.data.id).not.toBe(b1.body.data.id)
    // a foreign lease is rejected over MCP just like over REST
    const stolen = await callJson(agentB, "complete_item", {
      id: a1.body.data.id,
    })
    expect(stolen).toMatchObject({
      isError: true,
      body: { error: { code: "forbidden" } },
    })

    const [doneA, doneB] = await Promise.all([
      work(agentA, "agent-a", a1.body.data.id),
      work(agentB, "agent-b", b1.body.data.id),
    ])
    expect(doneA.length).toBeGreaterThan(0)
    expect(doneB.length).toBeGreaterThan(0)
    expect(doneA.filter((id) => doneB.includes(id))).toEqual([])
    expect(new Set([...doneA, ...doneB]).size).toBe(total)

    const mineA = await callJson(agentA, "get_my_items", {
      status: "completed",
    })
    expect(mineA.body.page.total).toBe(doneA.length)

    const actorsOf = async (id: string) => {
      const { body } = await callJson(producer, "get_item_history", { id })
      return body.data.map((e: { action: string; actor: string }) => [
        e.action,
        e.actor,
      ])
    }
    expect(await actorsOf(doneA[0])).toEqual([
      ["completed", "agent:agent-a"],
      ["heartbeat", "agent:agent-a"],
      ["claimed", "agent:agent-a"],
      ["created", "api_key:ci"],
    ])
    expect(await actorsOf(doneB[0])).toEqual([
      ["completed", "agent:agent-b"],
      ["heartbeat", "agent:agent-b"],
      ["claimed", "agent:agent-b"],
      ["created", "api_key:ci"],
    ])
    const { body: all } = await callJson(producer, "list_items", {
      tubeId,
      limit: 100,
    })
    const assignees = new Set(
      all.data.map((i: { assignedAgent: string }) => i.assignedAgent)
    )
    expect([...assignees].sort()).toEqual(["agent-a", "agent-b"])
  })

  it("serves item tools and resources through the stdio proxy as an agent", async () => {
    const client = await connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(ROOT, "bin/mcpocket-stdio.mjs")],
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          MCPOCKET_URL: baseUrl,
          MCPOCKET_API_KEY: SECRET,
          MCPOCKET_AGENT_ID: "stdio-agent",
        },
        stderr: "pipe",
      })
    )
    const { resources } = await client.listResources()
    expect(resources.map((r) => r.uri)).toContain("mcpocket://system/info")
    const { contents } = await client.readResource({
      uri: "mcpocket://system/info",
    })
    expect(JSON.parse((contents[0] as { text: string }).text).data.you).toEqual(
      {
        kind: "agent",
        id: "stdio-agent",
        viaKeyId: "ci",
        access: { role: "admin", scope: null },
      }
    )
    const { body: folder } = await callJson(client, "create_folder", {
      name: "stdio-e2e",
    })
    const { body: tube } = await callJson(client, "create_tube", {
      folderId: folder.data.id,
      name: "stdio-jobs",
    })
    await callJson(client, "push_item", {
      tubeId: tube.data.id,
      payload: { x: 1 },
    })
    const claim = await callJson(client, "claim_next_item", {
      tubeId: tube.data.id,
    })
    expect(claim.body.claim.agentId).toBe("stdio-agent")
    const { contents: item } = await client.readResource({
      uri: `mcpocket://items/${claim.body.data.id}`,
    })
    expect(
      JSON.parse((item[0] as { text: string }).text).data.assignedAgent
    ).toBe("stdio-agent")
  })
})

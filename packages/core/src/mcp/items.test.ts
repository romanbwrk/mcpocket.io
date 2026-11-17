import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Actor } from "../domain/actor"
import {
  createServiceContext,
  createServices,
  type ServiceContext,
} from "../services"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

import { RESOURCE_NOT_FOUND } from "./resources"
import { createMcpServer } from "./server"

let dataDir: string
let storage: Storage
let ctx: ServiceContext
let nowMs: number
let tubeId: string
const clients: Client[] = []

const MISSING = "00000000-0000-4000-8000-000000000000"
const agent = (id: string): Actor => ({ kind: "agent", id, viaKeyId: "ci" })
const KEY: Actor = { kind: "api_key", id: "ci" }

async function connect(actor: Actor) {
  const server = createMcpServer({
    services: async () => createServices(ctx, actor),
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  clients.push(client)
  return client
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
) {
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as CallToolResult
  const body = JSON.parse((result.content[0] as { text: string }).text)
  return { body, isError: result.isError === true }
}
async function ok(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
) {
  const res = await call(client, name, args)
  expect(res.isError, JSON.stringify(res.body)).toBe(false)
  return res.body
}
async function fails(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
) {
  const res = await call(client, name, args)
  expect(res.isError, JSON.stringify(res.body)).toBe(true)
  return res.body.error as { code: string; message: string; details?: unknown }
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-mcp-items-"))
  storage = await createJsonStorage({ dataDir })
  nowMs = Date.UTC(2026, 0, 1)
  ctx = createServiceContext(storage, {
    clock: { now: () => new Date(nowMs++) },
    leaseSeconds: 60,
  })
  const admin = createServices(ctx, KEY)
  const folder = await admin.folders.create({ name: "inbox" })
  const tube = await admin.tubes.create({
    folderId: folder.id,
    name: "jobs",
    description: "work to do",
    schemaDefinition: {
      type: "object",
      required: ["n"],
      properties: { n: { type: "integer" } },
    },
  })
  tubeId = tube.id
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe("MCP item tools", () => {
  it("lists every item and processing tool", async () => {
    const client = await connect(KEY)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "push_item",
        "get_item",
        "update_item",
        "delete_item",
        "list_items",
        "claim_next_item",
        "complete_item",
        "fail_item",
        "release_item",
        "heartbeat_item",
        "get_my_items",
        "get_item_history",
      ])
    )
    const claim = tools.find((t) => t.name === "claim_next_item")!
    expect(Object.keys(claim.inputSchema.properties ?? {})).not.toContain(
      "agentId"
    )
  })

  it("pushes, reads, updates, lists, and soft-deletes items", async () => {
    const client = await connect(KEY)
    const pushed = await ok(client, "push_item", {
      tubeId,
      payload: { n: 1 },
      tags: ["a"],
      idempotencyKey: "k1",
    })
    expect(pushed).toMatchObject({
      created: true,
      data: { status: "pending", payload: { n: 1 }, tags: ["a"] },
    })
    const id = pushed.data.id
    const replay = await ok(client, "push_item", {
      tubeId,
      payload: { n: 2 },
      idempotencyKey: "k1",
    })
    expect(replay).toMatchObject({ created: false, data: { id } })

    const bad = await fails(client, "push_item", {
      tubeId,
      payload: { n: "x" },
    })
    expect(bad.code).toBe("validation_error")
    expect((await fails(client, "push_item", { payload: {} })).code).toBe(
      "validation_error"
    )

    const updated = await ok(client, "update_item", {
      id,
      priority: 5,
      metadata: { m: true },
    })
    expect(updated.data).toMatchObject({ priority: 5, metadata: { m: true } })
    expect(
      (await fails(client, "update_item", { id, status: "processing" })).code
    ).toBe("conflict")

    expect((await ok(client, "get_item", { id })).data.id).toBe(id)
    const list = await ok(client, "list_items", { tubeId, limit: 10 })
    expect(list.page).toEqual({ offset: 0, limit: 10, total: 1 })

    expect(await ok(client, "delete_item", { id })).toEqual({
      deleted: true,
      id,
    })
    expect((await ok(client, "list_items", { tubeId })).page.total).toBe(0)
    expect(
      (await ok(client, "list_items", { tubeId, includeDeleted: true })).page
        .total
    ).toBe(1)
    expect((await fails(client, "get_item", { id: MISSING })).code).toBe(
      "not_found"
    )

    const history = await ok(client, "get_item_history", { id })
    expect(history.data.map((e: { action: string }) => e.action)).toEqual([
      "deleted",
      "updated",
      "created",
    ])
    expect(history.data[0].actor).toBe("api_key:ci")
  })

  it("runs the agent work loop with identity from the session", async () => {
    const producer = await connect(KEY)
    const bot = await connect(agent("bot-1"))
    const { data: item } = await ok(producer, "push_item", {
      tubeId,
      payload: { n: 1 },
    })

    // a non-agent session cannot claim, and the agent id cannot be passed in
    expect((await fails(producer, "claim_next_item", { tubeId })).code).toBe(
      "validation_error"
    )
    expect(
      (await fails(bot, "claim_next_item", { tubeId, agentId: "someone" })).code
    ).toBe("validation_error")
    expect((await fails(producer, "get_my_items")).code).toBe(
      "validation_error"
    )

    const claimed = await ok(bot, "claim_next_item", { tubeId })
    expect(claimed).toMatchObject({
      claimed: true,
      data: { id: item.id, status: "processing", assignedAgent: "bot-1" },
      claim: { itemId: item.id, agentId: "bot-1", attempts: 1 },
    })
    expect(await ok(bot, "claim_next_item", { tubeId })).toEqual({
      claimed: false,
      data: null,
      message: "Nothing to claim",
    })

    const before = claimed.data.leaseExpiresAt
    const beat = await ok(bot, "heartbeat_item", {
      id: item.id,
      leaseSeconds: 120,
    })
    expect(beat.data.leaseExpiresAt > before).toBe(true)

    const mine = await ok(bot, "get_my_items", { status: "processing" })
    expect(mine.data.map((i: { id: string }) => i.id)).toEqual([item.id])

    const done = await ok(bot, "complete_item", {
      id: item.id,
      result: { ok: true },
    })
    expect(done.data).toMatchObject({
      status: "completed",
      result: { ok: true },
      assignedAgent: "bot-1",
    })

    const history = await ok(bot, "get_item_history", { id: item.id })
    expect(
      history.data.map((e: { action: string; actor: string }) => [
        e.action,
        e.actor,
      ])
    ).toEqual([
      ["completed", "agent:bot-1"],
      ["heartbeat", "agent:bot-1"],
      ["claimed", "agent:bot-1"],
      ["created", "api_key:ci"],
    ])
  })

  it("enforces the same lease-owner rules as REST", async () => {
    const producer = await connect(KEY)
    const a = await connect(agent("bot-a"))
    const b = await connect(agent("bot-b"))
    for (const n of [1, 2]) {
      await ok(producer, "push_item", { tubeId, payload: { n } })
    }
    const { data: first } = await ok(a, "claim_next_item", { tubeId })

    // another agent's lease → forbidden; not processing → conflict
    for (const tool of ["complete_item", "release_item", "heartbeat_item"]) {
      expect((await fails(b, tool, { id: first.id })).code).toBe("forbidden")
    }
    expect(
      (await fails(b, "fail_item", { id: first.id, error: "nope" })).code
    ).toBe("forbidden")
    const { data: second } = await ok(producer, "list_items", { tubeId })
    const pending = second.find((i: { id: string }) => i.id !== first.id)
    expect((await fails(a, "complete_item", { id: pending.id })).code).toBe(
      "conflict"
    )

    // fail stores the error (attempts left → retry with backoff); release returns to pending
    const { data: claimedByB } = await ok(b, "claim_next_item", { tubeId })
    const failed = await ok(b, "fail_item", {
      id: claimedByB.id,
      error: { message: "boom", code: "E1" },
    })
    expect(failed.data).toMatchObject({
      status: "retry",
      retryAt: expect.any(String),
      lastError: { message: "boom", code: "E1", agentId: "bot-b" },
    })
    const released = await ok(a, "release_item", {
      id: first.id,
      reason: "later",
    })
    expect(released.data).toMatchObject({
      status: "pending",
      assignedAgent: null,
    })

    // expired lease → conflict for the old owner, reclaimable by others
    await ok(a, "claim_next_item", { tubeId, leaseSeconds: 1 })
    nowMs += 5_000
    expect((await fails(a, "heartbeat_item", { id: first.id })).code).toBe(
      "conflict"
    )
    const reclaimed = await ok(b, "claim_next_item", { tubeId })
    expect(reclaimed.claim).toMatchObject({
      itemId: first.id,
      agentId: "bot-b",
      attempts: 3,
    })
  })
})

describe("MCP resources", () => {
  it("lists static resources, tube resources and the item template", async () => {
    const client = await connect(agent("reader"))
    const { resources } = await client.listResources()
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining([
        "mcpocket://folders/tree",
        "mcpocket://system/info",
        `mcpocket://tubes/${tubeId}`,
      ])
    )
    const { resourceTemplates } = await client.listResourceTemplates()
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      "mcpocket://items/{id}",
      "mcpocket://tubes/{id}",
    ])
  })

  async function readJson(client: Client, uri: string) {
    const { contents } = await client.readResource({ uri })
    expect(contents[0]).toMatchObject({ uri, mimeType: "application/json" })
    return JSON.parse((contents[0] as { text: string }).text)
  }

  it("reads folder tree, system info, tube and item details", async () => {
    const client = await connect(agent("reader"))
    const tree = await readJson(client, "mcpocket://folders/tree")
    expect(tree.data[0]).toMatchObject({
      name: "inbox",
      tubes: [{ id: tubeId, name: "jobs" }],
    })

    const system = await readJson(client, "mcpocket://system/info")
    expect(system.data).toMatchObject({
      server: { name: "mcpocket" },
      storage: { driver: "json" },
      processing: { defaultLeaseSeconds: 60 },
      you: { kind: "agent", id: "reader" },
    })
    expect(system.data.tools).toContain("claim_next_item")

    const { data: item } = await ok(client, "push_item", {
      tubeId,
      payload: { n: 7 },
    })
    const tube = await readJson(client, `mcpocket://tubes/${tubeId}`)
    expect(tube.data).toMatchObject({
      id: tubeId,
      description: "work to do",
      schemaDefinition: { required: ["n"] },
      itemCount: 1,
    })

    await ok(client, "claim_next_item", { tubeId })
    const detail = await readJson(client, `mcpocket://items/${item.id}`)
    expect(detail.data).toMatchObject({ id: item.id, status: "processing" })
    expect(
      detail.history.data.map((e: { action: string }) => e.action)
    ).toEqual(["claimed", "created"])
  })

  it("reports unknown ids as resource-not-found errors", async () => {
    const client = await connect(KEY)
    await expect(
      client.readResource({ uri: `mcpocket://items/${MISSING}` })
    ).rejects.toMatchObject({ code: RESOURCE_NOT_FOUND })
    await expect(
      client.readResource({ uri: `mcpocket://tubes/${MISSING}` })
    ).rejects.toMatchObject({ code: RESOURCE_NOT_FOUND })
    await expect(
      client.readResource({ uri: "mcpocket://tubes/not-an-id" })
    ).rejects.toMatchObject({ code: RESOURCE_NOT_FOUND })
  })
})

describe("MCP search & bulk tools", () => {
  it("advertises search_items, bulk_push_items, bulk_update_items", async () => {
    const client = await connect(KEY)
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((t) => [t.name, t]))
    const search = byName.get("search_items")!
    expect(Object.keys(search.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining([
        "tubeId",
        "status",
        "assignedAgent",
        "createdFrom",
        "createdTo",
        "priority",
        "tags",
        "payload",
        "offset",
        "limit",
      ])
    )
    expect(search.annotations?.readOnlyHint).toBe(true)
    expect(byName.get("bulk_push_items")!.inputSchema.required).toEqual(
      expect.arrayContaining(["tubeId", "items"])
    )
    expect(byName.has("bulk_update_items")).toBe(true)
  })

  it("bulk-pushes, searches and bulk-updates through the shared services", async () => {
    const client = await connect(agent("bot-1"))
    const pushed = await ok(client, "bulk_push_items", {
      tubeId,
      items: [
        { payload: { n: 1, meta: { region: "eu" } }, tags: ["x"] },
        { payload: { n: 2, meta: { region: "us" } }, idempotencyKey: "k" },
        { payload: { n: "bad" } },
        { payload: { n: 3, meta: { region: "eu" } }, idempotencyKey: "k" },
      ],
    })
    expect(pushed.summary).toEqual({
      total: 4,
      succeeded: 3,
      failed: 1,
      created: 2,
    })
    expect(pushed.results[3]).toMatchObject({ ok: true, created: false })

    const eu = await ok(client, "search_items", {
      tubeId,
      payload: [{ path: "meta.region", value: "eu" }],
    })
    expect(eu.page.total).toBe(1)
    expect(eu.data[0].payload.n).toBe(1)

    const across = await ok(client, "search_items", {
      status: ["pending"],
      payload: [{ path: "n", op: "in", value: [1, 2] }],
      limit: 1,
    })
    expect(across.page).toEqual({ offset: 0, limit: 1, total: 2 })

    const listed = await ok(client, "list_items", { tubeId, tags: "x" })
    expect(listed.page.total).toBe(1)

    const ids = [pushed.results[0].data.id, pushed.results[1].data.id]
    const updated = await ok(client, "bulk_update_items", {
      ids,
      patch: { status: "cancelled" },
    })
    expect(updated.summary).toEqual({ total: 2, succeeded: 2, failed: 0 })
    const history = await ok(client, "get_item_history", { id: ids[0] })
    expect(history.data[0]).toMatchObject({
      action: "status_changed",
      actor: "agent:bot-1",
    })

    const perItem = await ok(client, "bulk_update_items", {
      items: [
        { id: ids[0], priority: 3 },
        { id: ids[1], status: "processing" },
      ],
    })
    expect(perItem.results[1]).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    })

    const err = await fails(client, "search_items", { status: "nope" })
    expect(err.code).toBe("validation_error")
    const tooMany = await fails(client, "bulk_push_items", {
      tubeId,
      items: Array.from({ length: 501 }, () => ({ payload: { n: 1 } })),
    })
    expect(tooMany.code).toBe("validation_error")
  })
})

describe("MCP item output options", () => {
  async function seed(client: Client) {
    const ids: string[] = []
    for (const n of [1, 2, 3, 4]) {
      const { data } = await ok(client, "push_item", {
        tubeId,
        payload: { n, label: `item ${n}`, meta: { size: n * 10 } },
        tags: n % 2 ? ["odd"] : ["even"],
      })
      ids.push(data.id)
    }
    return ids
  }

  it("advertises fields, field, order and countOnly", async () => {
    const client = await connect(KEY)
    const { tools } = await client.listTools()
    const props = (name: string) =>
      Object.keys(tools.find((t) => t.name === name)!.inputSchema.properties!)
    for (const name of ["list_items", "search_items"]) {
      expect(props(name)).toEqual(
        expect.arrayContaining(["fields", "field", "order", "countOnly"])
      )
    }
    expect(props("get_item")).toEqual(
      expect.arrayContaining(["fields", "field"])
    )
    expect(props("claim_next_item")).toEqual(
      expect.arrayContaining(["fields", "field"])
    )
  })

  it("orders newest first and limits to n items", async () => {
    const client = await connect(KEY)
    const ids = await seed(client)
    const latest = await ok(client, "list_items", {
      tubeId,
      order: "desc",
      limit: 2,
      field: "id",
    })
    expect(latest).toEqual({
      data: [ids[3], ids[2]],
      page: { offset: 0, limit: 2, total: 4 },
    })
    const next = await ok(client, "list_items", {
      tubeId,
      order: "desc",
      offset: 2,
      limit: 5,
      field: "id",
    })
    expect(next.data).toEqual([ids[1], ids[0]])
    const past = await ok(client, "list_items", {
      tubeId,
      order: "desc",
      offset: 10,
      field: "id",
    })
    expect(past.data).toEqual([])
    // Filtered (in-memory) path.
    const odd = await ok(client, "search_items", {
      tubeId,
      tags: ["odd"],
      order: "desc",
      field: "payload.n",
    })
    expect(odd.data).toEqual([3, 1])
  })

  it("projects fields and single values", async () => {
    const client = await connect(KEY)
    const ids = await seed(client)
    const page = await ok(client, "list_items", {
      tubeId,
      limit: 2,
      fields: ["id", "payload.label", "payload.meta.size", "missing.path"],
    })
    expect(page.data).toEqual([
      { id: ids[0], payload: { label: "item 1", meta: { size: 10 } } },
      { id: ids[1], payload: { label: "item 2", meta: { size: 20 } } },
    ])
    const labels = await ok(client, "search_items", {
      tubeId,
      field: "payload.label",
    })
    expect(labels.data).toEqual(["item 1", "item 2", "item 3", "item 4"])

    const one = await ok(client, "get_item", {
      id: ids[2],
      fields: ["status", "payload.n"],
    })
    expect(one).toEqual({ data: { status: "pending", payload: { n: 3 } } })
    const value = await ok(client, "get_item", {
      id: ids[2],
      field: "payload.nope",
    })
    expect(value).toEqual({ data: null })
  })

  it("counts without returning items", async () => {
    const client = await connect(KEY)
    await seed(client)
    expect(await ok(client, "list_items", { tubeId, countOnly: true })).toEqual(
      { total: 4 }
    )
    expect(
      await ok(client, "search_items", {
        tubeId,
        tags: ["even"],
        countOnly: true,
      })
    ).toEqual({ total: 2 })
  })

  it("trims a claimed item and lists my items newest first", async () => {
    const client = await connect(KEY)
    const ids = await seed(client)
    const worker = await connect(agent("bot"))
    const claimed = await ok(worker, "claim_next_item", {
      tubeId,
      field: "payload.label",
    })
    expect(claimed).toMatchObject({
      claimed: true,
      data: "item 1",
      claim: { itemId: ids[0] },
    })
    await ok(worker, "claim_next_item", { tubeId })
    const mine = await ok(worker, "get_my_items", {
      order: "desc",
      field: "id",
    })
    expect(mine.data).toEqual([ids[1], ids[0]])
  })

  it("rejects invalid output options", async () => {
    const client = await connect(KEY)
    await seed(client)
    for (const args of [
      { fields: ["id"], field: "id" },
      { fields: [] },
      { field: "a..b" },
      { order: "random" },
    ]) {
      const error = await fails(client, "list_items", { tubeId, ...args })
      expect(error.code).toBe("validation_error")
    }
  })
})

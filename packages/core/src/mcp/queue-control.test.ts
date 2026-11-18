import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Role } from "../domain/access"
import type { Actor } from "../domain/actor"
import {
  createServiceContext,
  createServices,
  type ServiceContext,
} from "../services"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

import { createMcpServer } from "./server"

/**
 * Tubes as an external job queue: leases that
 * never expire, operator status overrides the lease holder cannot undo,
 * result on update / fail, bulk delete, forced tube delete, filtered bulk
 * update and tube counts.
 */

let dataDir: string
let storage: Storage
let ctx: ServiceContext
let nowMs: number
let tubeId: string
const clients: Client[] = []

const DAY_MS = 86_400_000
/** One fixed agent id per install, authenticated by an operator key. */
const keyed = (role: Role, agentId = "runner"): Actor => ({
  kind: "agent",
  id: agentId,
  viaKeyId: "k",
  access: { role, scope: null },
})

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

async function push(client: Client, n: number, tube = tubeId) {
  return (await ok(client, "push_item", { tubeId: tube, payload: { n } })).data
    .id as string
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-queue-control-"))
  storage = await createJsonStorage({ dataDir })
  nowMs = Date.UTC(2026, 0, 1)
  ctx = createServiceContext(storage, {
    clock: { now: () => new Date(nowMs++) },
    leaseSeconds: 60,
  })
  const tube = await createServices(ctx, keyed("admin")).tubes.create({
    name: "devices",
  })
  tubeId = tube.id
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe("leases that never expire (leaseSeconds: 0)", () => {
  it("claim_next_item { leaseSeconds: 0 } is never reclaimed", async () => {
    const op = await connect(keyed("operator"))
    const id = await push(op, 1)
    const claimed = await ok(op, "claim_next_item", { tubeId, leaseSeconds: 0 })
    expect(claimed.claim).toMatchObject({ itemId: id, leaseExpiresAt: null })
    expect(claimed.data.leaseExpiresAt).toBeNull()

    nowMs += 30 * DAY_MS // far past any lease; the sweeper finds nothing
    const again = await ok(op, "claim_next_item", { tubeId })
    expect(again.claimed).toBe(false)
    expect((await ok(op, "get_item", { id })).data.status).toBe("processing")

    const done = await ok(op, "complete_item", { id, result: { ok: 1 } })
    expect(done.data).toMatchObject({ status: "completed", result: { ok: 1 } })
  })

  it("a tube's leaseSeconds: 0 (create_tube / update_tube) is the default", async () => {
    const op = await connect(keyed("operator"))
    const created = await ok(op, "create_tube", {
      name: "forever",
      leaseSeconds: 0,
    })
    expect(created.data.leaseSeconds).toBe(0)
    await push(op, 1, created.data.id)
    const claimed = await ok(op, "claim_next_item", { tubeId: created.data.id })
    expect(claimed.claim.leaseExpiresAt).toBeNull()

    const updated = await ok(op, "update_tube", { id: tubeId, leaseSeconds: 0 })
    expect(updated.data.leaseSeconds).toBe(0)
    await push(op, 2)
    expect(
      (await ok(op, "claim_next_item", { tubeId })).claim.leaseExpiresAt
    ).toBeNull()
    // An explicit lease still overrides the tube's default.
    await push(op, 3)
    expect(
      (await ok(op, "claim_next_item", { tubeId, leaseSeconds: 5 })).claim
        .leaseExpiresAt
    ).not.toBeNull()
  })
})

describe("manual status changes end the lease", () => {
  it("→ pending: the holder gets conflict; the item keeps its place", async () => {
    const op = await connect(keyed("operator"))
    const first = await push(op, 1)
    await push(op, 2)
    await ok(op, "claim_next_item", { tubeId, leaseSeconds: 0 })

    const reset = await ok(op, "update_item", { id: first, status: "pending" })
    expect(reset.data).toMatchObject({
      status: "pending",
      assignedAgent: null,
      leaseExpiresAt: null,
    })

    for (const [tool, args] of [
      ["complete_item", { result: { late: true } }],
      ["fail_item", { error: "late" }],
      ["release_item", {}],
      ["heartbeat_item", {}],
    ] as const) {
      expect((await fails(op, tool, { id: first, ...args })).code).toBe(
        "conflict"
      )
    }
    const item = (await ok(op, "get_item", { id: first })).data
    expect(item).toMatchObject({ status: "pending" })
    expect(item.result).toBeUndefined()

    // Still first in line.
    const next = await ok(op, "claim_next_item", { tubeId })
    expect(next.claim.itemId).toBe(first)
  })

  it("→ completed / failed / cancelled / archived keep assignedAgent", async () => {
    const op = await connect(keyed("operator"))
    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "archived",
    ] as const) {
      const id = await push(op, 1)
      await ok(op, "claim_next_item", { tubeId })
      const updated = await ok(op, "update_item", { id, status })
      expect(updated.data).toMatchObject({
        status,
        assignedAgent: "runner",
        leaseExpiresAt: null,
      })
      expect((await fails(op, "complete_item", { id })).code).toBe("conflict")
      expect((await ok(op, "get_item", { id })).data.status).toBe(status)
    }
  })

  it("any status from any status, except processing", async () => {
    const op = await connect(keyed("operator"))
    const id = await push(op, 1)
    await ok(op, "update_item", { id, status: "archived" })
    await ok(op, "update_item", { id, status: "completed" })
    await ok(op, "update_item", { id, status: "pending" })
    const err = await fails(op, "update_item", { id, status: "processing" })
    expect(err.code).toBe("validation_error")
  })
})

describe("result without a lease", () => {
  it("update_item stores, records and clears a result", async () => {
    const op = await connect(keyed("operator"))
    const id = await push(op, 1)
    const done = await ok(op, "update_item", {
      id,
      status: "completed",
      result: { screenshots: 3 },
    })
    expect(done.data).toMatchObject({
      status: "completed",
      result: { screenshots: 3 },
    })
    const history = (await ok(op, "get_item_history", { id })).data
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "updated",
          oldValue: { result: null },
          newValue: { result: { screenshots: 3 } },
        }),
      ])
    )

    const cleared = await ok(op, "update_item", { id, result: null })
    expect(cleared.data.result).toBeUndefined()
  })

  it("bulk_update_items takes result per item and in patch", async () => {
    const op = await connect(keyed("operator"))
    const a = await push(op, 1)
    const b = await push(op, 2)
    const perItem = await ok(op, "bulk_update_items", {
      items: [{ id: a, status: "failed", result: { why: "x" } }],
    })
    expect(perItem.results[0].data).toMatchObject({
      status: "failed",
      result: { why: "x" },
    })
    const shared = await ok(op, "bulk_update_items", {
      ids: [a, b],
      patch: { result: "done" },
    })
    expect(shared.summary.succeeded).toBe(2)
    expect((await ok(op, "get_item", { id: b })).data.result).toBe("done")
  })

  it("fail_item stores result next to the error", async () => {
    const op = await connect(keyed("operator"))
    const id = await push(op, 1)
    await ok(op, "claim_next_item", { tubeId })
    const failed = await ok(op, "fail_item", {
      id,
      error: "device offline",
      result: { log: "..." },
    })
    expect(failed.data).toMatchObject({
      result: { log: "..." },
      lastError: { message: "device offline" },
    })
  })
})

describe("bulk_delete_items", () => {
  it("deletes by tube + status, including processing items", async () => {
    const op = await connect(keyed("operator"))
    const ids = [await push(op, 1), await push(op, 2), await push(op, 3)]
    await ok(op, "update_item", { id: ids[0], status: "completed" })
    await ok(op, "update_item", { id: ids[1], status: "completed" })

    const res = await ok(op, "bulk_delete_items", {
      tubeId,
      status: "completed",
    })
    expect(res).toEqual({ deleted: 2 })
    const left = await ok(op, "list_items", { tubeId })
    expect(left.data.map((i: { id: string }) => i.id)).toEqual([ids[2]])
    expect(
      (await ok(op, "get_item_history", { id: ids[0] })).data[0].action
    ).toBe("deleted")

    // processing: deleted anyway, the lease is dropped
    await ok(op, "claim_next_item", { tubeId })
    const all = await ok(op, "bulk_delete_items", { tubeId })
    expect(all.deleted).toBe(1)
    expect((await fails(op, "complete_item", { id: ids[2] })).code).toBe(
      "conflict"
    )
    expect((await ok(op, "get_item", { id: ids[2] })).data).toMatchObject({
      leaseExpiresAt: null,
    })
  })

  it("deletes by ids with per-item results", async () => {
    const op = await connect(keyed("operator"))
    const a = await push(op, 1)
    const missing = "00000000-0000-4000-8000-000000000000"
    const res = await ok(op, "bulk_delete_items", { ids: [a, missing, a] })
    expect(res.deleted).toBe(1)
    expect(res.results).toMatchObject([
      { index: 0, ok: true },
      { index: 1, ok: false, id: missing, error: { code: "not_found" } },
      { index: 2, ok: false, id: a, error: { code: "conflict" } },
    ])
    expect(
      (await fails(op, "bulk_delete_items", { ids: [a], tubeId })).code
    ).toBe("validation_error")
  })

  it("is for operators and admins only", async () => {
    const agent = await connect(keyed("agent"))
    const { tools } = await agent.listTools()
    expect(tools.map((t) => t.name)).not.toContain("bulk_delete_items")
    expect((await fails(agent, "bulk_delete_items", { tubeId })).code).toBe(
      "forbidden"
    )
  })
})

describe("delete_tube { force }", () => {
  it("deletes a tube that still has items", async () => {
    const op = await connect(keyed("operator"))
    await push(op, 1)
    await push(op, 2)
    await ok(op, "claim_next_item", { tubeId })
    expect((await fails(op, "delete_tube", { id: tubeId })).code).toBe(
      "conflict"
    )
    const res = await ok(op, "delete_tube", { id: tubeId, force: true })
    expect(res).toEqual({ deleted: true, id: tubeId, deletedItems: 2 })
    expect((await ok(op, "list_tubes", {})).data).toEqual([])
  })
})

describe("bulk_update_items by filter", () => {
  it("resets every processing item to pending, no cap", async () => {
    const op = await connect(keyed("operator"))
    for (let n = 0; n < 4; n++) await push(op, n)
    await ok(op, "claim_next_item", { tubeId, leaseSeconds: 0 })
    await ok(op, "claim_next_item", { tubeId, leaseSeconds: 0 })

    const res = await ok(op, "bulk_update_items", {
      tubeId,
      filter: { status: "processing" },
      patch: { status: "pending" },
    })
    expect(res).toEqual({ affected: 2 })
    const counts = (await ok(op, "list_tubes", { withCounts: true })).data[0]
      .counts
    expect(counts).toMatchObject({ pending: 4, processing: 0 })

    // Already pending: nothing changes.
    expect(
      await ok(op, "bulk_update_items", {
        tubeId,
        filter: { status: "pending" },
        patch: { status: "pending" },
      })
    ).toEqual({ affected: 0 })
    expect(
      (
        await fails(op, "bulk_update_items", {
          tubeId,
          filter: {},
          patch: { status: "processing" },
        })
      ).code
    ).toBe("validation_error")
    expect(
      (await fails(op, "bulk_update_items", { tubeId, patch: { priority: 1 } }))
        .code
    ).toBe("validation_error")
  })
})

describe("list_tubes { withCounts, name }", () => {
  it("adds counts per status and matches a name exactly", async () => {
    const op = await connect(keyed("operator"))
    await ok(op, "create_tube", { name: "devices-2" })
    const id = await push(op, 1)
    await push(op, 2)
    await ok(op, "update_item", { id, status: "failed" })

    const plain = await ok(op, "list_tubes", {})
    expect(plain.data).toHaveLength(2)
    expect(plain.data[0].counts).toBeUndefined()

    const named = await ok(op, "list_tubes", {
      name: "devices",
      withCounts: true,
    })
    expect(named.page.total).toBe(1)
    expect(named.data[0]).toMatchObject({
      id: tubeId,
      counts: {
        pending: 1,
        processing: 0,
        completed: 0,
        failed: 1,
        retry: 0,
        cancelled: 0,
        archived: 0,
      },
    })
    expect((await ok(op, "list_tubes", { name: "Devices" })).data).toEqual([])
  })
})

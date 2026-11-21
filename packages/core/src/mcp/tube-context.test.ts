import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Role } from "../domain/access"
import type { Actor } from "../domain/actor"
import { ForbiddenError, NotFoundError } from "../domain/errors"
import { MAX_TUBE_MEMORY_BLOCKS } from "../domain/schemas"
import {
  createServiceContext,
  createServices,
  type ServiceContext,
} from "../services"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

import {
  narrowActor,
  scopedInstructions,
  scopedTools,
  SCOPED_MEMORY_BUDGET,
  tubeContextInstructions,
} from "./connection-scope"
import { createMcpServer } from "./server"

/** Tube instructions (like a skill) and memory blocks. */

let dataDir: string
let storage: Storage
let ctx: ServiceContext
let nowMs: number
let tubeId: string
const clients: Client[] = []

const keyed = (role: Role): Actor => ({
  kind: "agent",
  id: "runner",
  viaKeyId: "k",
  access: { role, scope: null },
})
const svc = (role: Role = "admin") => createServices(ctx, keyed(role))

async function connect(actor: Actor, tube?: string) {
  const target = tube ? { kind: "tube" as const, id: tube } : undefined
  const bound = target ? narrowActor(actor, target) : actor
  const server = createMcpServer({
    services: async () => createServices(ctx, bound),
    ...(target && { tools: scopedTools(target) }),
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

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-tube-context-"))
  storage = await createJsonStorage({ dataDir })
  nowMs = Date.UTC(2026, 0, 1)
  ctx = createServiceContext(storage, {
    clock: { now: () => new Date(nowMs++) },
  })
  tubeId = (await svc().tubes.create({ name: "images" })).id
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe("tube instructions", () => {
  it("are set on create / update, cleared with null or empty, and cloned", async () => {
    const t = await svc().tubes.create({ name: "x", instructions: "# Do X" })
    expect(t.instructions).toBe("# Do X")

    const updated = await svc().tubes.update(tubeId, {
      instructions: "Be brief",
    })
    expect(updated.instructions).toBe("Be brief")
    expect(await svc().tubes.context(tubeId)).toEqual({
      tubeId,
      name: "images",
      instructions: "Be brief",
      memory: [],
    })

    await svc().tubes.addMemory(tubeId, { text: "note" })
    const { tube: copy } = await svc().tubes.clone(tubeId)
    expect(copy.instructions).toBe("Be brief")
    expect(copy.memory?.map((b) => b.text)).toEqual(["note"])
    expect(copy.memory?.[0].id).not.toBe(
      (await svc().tubes.get(tubeId)).memory?.[0].id
    )

    expect(
      (await svc().tubes.update(tubeId, { instructions: "" })).instructions
    ).toBeUndefined()
    await svc().tubes.update(tubeId, { instructions: "again" })
    expect(
      (await svc().tubes.update(tubeId, { instructions: null })).instructions
    ).toBeUndefined()
  })

  it("need structure:manage to change", async () => {
    await expect(
      svc("agent").tubes.update(tubeId, { instructions: "x" })
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe("tube memory", () => {
  it("adds, updates and deletes blocks", async () => {
    const a = await svc("agent").tubes.addMemory(tubeId, { text: " first " })
    expect(a).toMatchObject({ text: "first" })
    const b = await svc("agent").tubes.addMemory(tubeId, { text: "second" })

    const edited = await svc("agent").tubes.updateMemory(tubeId, a.id, {
      text: "first, edited",
    })
    expect(edited).toMatchObject({ id: a.id, createdAt: a.createdAt })
    expect(edited.updatedAt > a.updatedAt).toBe(true)

    const { memory } = await svc("readonly").tubes.context(tubeId)
    expect(memory.map((m) => m.text)).toEqual(["first, edited", "second"])

    await svc("agent").tubes.deleteMemory(tubeId, b.id)
    await svc("agent").tubes.deleteMemory(tubeId, a.id)
    expect((await svc().tubes.get(tubeId)).memory).toBeUndefined()
  })

  it("rejects unknown blocks, empty text, readonly writers and a full memory", async () => {
    await expect(
      svc().tubes.deleteMemory(tubeId, crypto.randomUUID())
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      svc().tubes.addMemory(tubeId, { text: "   " })
    ).rejects.toThrow()
    await expect(
      svc("readonly").tubes.addMemory(tubeId, { text: "x" })
    ).rejects.toBeInstanceOf(ForbiddenError)

    for (let i = 0; i < MAX_TUBE_MEMORY_BLOCKS; i++) {
      await svc().tubes.addMemory(tubeId, { text: `n${i}` })
    }
    await expect(
      svc().tubes.addMemory(tubeId, { text: "overflow" })
    ).rejects.toMatchObject({ code: "conflict" })
  })
})

describe("MCP tube context tools", () => {
  it("default tubeId on a tube-scoped connection", async () => {
    await svc().tubes.update(tubeId, { instructions: "Use 1024px" })
    const agent = await connect(keyed("agent"), tubeId)

    const added = await call(agent, "add_tube_memory", { text: "API is slow" })
    expect(added.isError).toBe(false)
    const memoryId = added.body.data.id

    const ctxRes = await call(agent, "get_tube_context")
    expect(ctxRes.body.data).toMatchObject({
      tubeId,
      instructions: "Use 1024px",
      memory: [{ id: memoryId, text: "API is slow" }],
    })

    expect(
      (await call(agent, "update_tube_memory", { memoryId, text: "slower" }))
        .body.data.text
    ).toBe("slower")
    expect(
      (await call(agent, "delete_tube_memory", { memoryId })).body.deleted
    ).toBe(true)
    expect(
      (await call(agent, "delete_tube_memory", { memoryId })).body.error.code
    ).toBe("not_found")
  })

  it("are hidden from readonly keys", async () => {
    const ro = await connect(keyed("readonly"))
    const { tools } = await ro.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain("get_tube_context")
    expect(names).not.toContain("add_tube_memory")
  })
})

describe("tube-scoped connection instructions", () => {
  it("include the tube's instructions and memory", async () => {
    await svc().tubes.update(tubeId, { instructions: "Always PNG" })
    await svc().tubes.addMemory(tubeId, { text: "Model X is down" })
    const tube = await svc().tubes.get(tubeId)
    const text = scopedInstructions(
      { kind: "tube", id: tubeId },
      tube.name,
      [],
      tube
    )
    expect(text).toContain("## Tube instructions")
    expect(text).toContain("Always PNG")
    expect(text).toContain("Model X is down")
  })

  it("keep the newest memory within the budget", () => {
    const block = (i: number) => ({
      id: `id-${i}`,
      text: `${i}`.padEnd(1000, "."),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    const n = Math.ceil(SCOPED_MEMORY_BUDGET / 1000) + 5
    const memory = Array.from({ length: n }, (_, i) => block(i))
    const text = tubeContextInstructions({ id: "t", memory })
    expect(text).toContain(`[id-${n - 1}]`)
    expect(text).not.toContain("[id-0]")
    expect(text).toMatch(/older block\(s\) omitted/)
  })
})

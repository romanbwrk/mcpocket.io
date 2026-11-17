import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"

import type { Actor } from "../domain/actor"
import { createServiceContext, createServices } from "../services"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

import { createMcpServer } from "./server"
import { defineTool, mcpTools } from "./tools"

let dataDir: string
let storage: Storage
let client: Client

const ACTOR: Actor = { kind: "agent", id: "bot-1", viaKeyId: "ci" }
const MISSING = "00000000-0000-4000-8000-000000000000"

const whoami = defineTool({
  name: "whoami",
  description: "test-only: echoes the bound actor",
  input: z.object({}),
  run: async (services) => ({ actor: services.actor }),
})

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-mcp-"))
  storage = await createJsonStorage({ dataDir })
  const server = createMcpServer({
    services: async () => createServices(createServiceContext(storage), ACTOR),
    tools: [...mcpTools, whoami],
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
})
afterEach(async () => {
  await client.close()
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as CallToolResult
  const text = (result.content[0] as { text: string }).text
  return { result, body: JSON.parse(text), isError: result.isError === true }
}
async function ok(name: string, args: Record<string, unknown> = {}) {
  const res = await call(name, args)
  expect(res.isError, JSON.stringify(res.body)).toBe(false)
  expect(res.result.structuredContent).toEqual(res.body)
  return res.body
}
async function fails(name: string, args: Record<string, unknown> = {}) {
  const res = await call(name, args)
  expect(res.isError).toBe(true)
  return res.body.error as { code: string; message: string; details?: unknown }
}

describe("MCP server", () => {
  it("identifies as mcpocket and lists the folder/tube tools with JSON schemas", async () => {
    expect(client.getServerVersion()?.name).toBe("mcpocket")
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "list_folders",
        "create_folder",
        "update_folder",
        "move_folder",
        "delete_folder",
        "get_folder_tree",
        "list_tubes",
        "create_tube",
        "update_tube",
        "move_tube",
        "delete_tube",
      ])
    )
    const createTube = tools.find((t) => t.name === "create_tube")!
    expect(createTube.inputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["name"]),
      properties: {
        folderId: {
          anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
        },
        enabled: { type: "boolean" },
      },
    })
    const updateFolder = tools.find((t) => t.name === "update_folder")!
    expect(updateFolder.inputSchema.required).toEqual(["id"])
    expect(Object.keys(updateFolder.inputSchema.properties!)).toEqual(
      expect.arrayContaining(["id", "name", "description", "parentId"])
    )
  })

  it("binds the session actor into the services", async () => {
    expect(await ok("whoami")).toEqual({ actor: ACTOR })
  })

  it("manages folders and tubes end to end", async () => {
    const { data: root } = await ok("create_folder", { name: "Root" })
    const { data: other } = await ok("create_folder", { name: "Other" })
    const { data: child } = await ok("create_folder", {
      name: "Child",
      parentId: root.id,
    })
    expect(child.parentId).toBe(root.id)

    const roots = await ok("list_folders", { parentId: null })
    expect(roots.data.map((f: { name: string }) => f.name)).toEqual([
      "Root",
      "Other",
    ])
    expect(roots.page).toEqual({ offset: 0, limit: 100, total: 2 })

    const { data: renamed } = await ok("update_folder", {
      id: child.id,
      name: "Kid",
      description: "d",
    })
    expect(renamed).toMatchObject({ name: "Kid", description: "d" })
    const { data: moved } = await ok("move_folder", {
      id: child.id,
      parentId: other.id,
    })
    expect(moved.parentId).toBe(other.id)

    const { data: tube } = await ok("create_tube", {
      folderId: child.id,
      name: "inbox",
      schemaDefinition: { type: "object" },
    })
    expect(tube).toMatchObject({ enabled: true, folderId: child.id })
    const { data: updatedTube } = await ok("update_tube", {
      id: tube.id,
      enabled: false,
      schemaDefinition: null,
    })
    expect(updatedTube.enabled).toBe(false)
    expect(updatedTube.schemaDefinition).toBeUndefined()
    const { data: movedTube } = await ok("move_tube", {
      id: tube.id,
      folderId: root.id,
    })
    expect(movedTube.folderId).toBe(root.id)
    expect(
      (await ok("list_tubes", { folderId: root.id })).data.map(
        (t: { id: string }) => t.id
      )
    ).toEqual([tube.id])

    const { data: tree } = await ok("get_folder_tree")
    expect(tree).toHaveLength(2)
    expect(tree[0].tubes.map((t: { name: string }) => t.name)).toEqual([
      "inbox",
    ])
    expect(tree[1].children.map((f: { name: string }) => f.name)).toEqual([
      "Kid",
    ])

    // Same conflict semantics as REST: non-empty folder can't be deleted.
    expect((await fails("delete_folder", { id: root.id })).code).toBe(
      "conflict"
    )
    expect(await ok("delete_tube", { id: tube.id })).toEqual({
      deleted: true,
      id: tube.id,
    })
    expect(await ok("delete_folder", { id: root.id })).toEqual({
      deleted: true,
      id: root.id,
    })
  })

  it("reports service validation errors like REST (code + per-field details)", async () => {
    const err = await fails("create_folder", { name: "" })
    expect(err.code).toBe("validation_error")
    expect(err.details).toEqual([
      expect.objectContaining({ path: "name", code: expect.any(String) }),
    ])
    expect((await fails("create_folder", { name: "x", bogus: 1 })).code).toBe(
      "validation_error"
    )
    expect(
      (await fails("update_folder", { id: "nope", name: "x" })).details
    ).toEqual([expect.objectContaining({ path: "id" })])
    expect((await fails("move_tube", { id: MISSING })).details).toEqual([
      expect.objectContaining({ path: "folderId" }),
    ])
  })

  it("reports not_found and conflict errors as tool errors", async () => {
    expect(await fails("delete_tube", { id: MISSING })).toMatchObject({
      code: "not_found",
      details: { entity: "Tube", id: MISSING },
    })
    expect(
      (await fails("create_tube", { folderId: MISSING, name: "t" })).code
    ).toBe("not_found")
    const { data: a } = await ok("create_folder", { name: "A" })
    const { data: b } = await ok("create_folder", { name: "B", parentId: a.id })
    expect(
      (await fails("move_folder", { id: a.id, parentId: b.id })).code
    ).toBe("conflict")
  })

  it("rejects unknown tools with a protocol error", async () => {
    await expect(client.callTool({ name: "nope" })).rejects.toThrow(/not found/)
  })
})

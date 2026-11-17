import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ZodError } from "zod"

import { ConflictError, NotFoundError, ValidationError } from "../domain/errors"
import { validateJsonSchema } from "../domain/json-schema"
import { createServiceContext, createServices } from "./index"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"
import { makeItem } from "../storage/testing/contract"

let dataDir: string
let storage: Storage
let services: ReturnType<typeof createServices>

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-tubes-"))
  storage = await createJsonStorage({ dataDir })
  services = createServices(createServiceContext(storage), {
    kind: "api_key",
    id: "test",
  })
})
afterEach(async () => {
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

const PERSON = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "integer" } },
  required: ["name"],
}

describe("tube service", () => {
  it("creates tubes in an existing folder with defaults and configures them", async () => {
    const f = await services.folders.create({ name: "f" })
    const tube = await services.tubes.create({ folderId: f.id, name: "Inbox" })
    expect(tube).toMatchObject({ folderId: f.id, name: "Inbox", enabled: true })
    expect(tube.schemaDefinition).toBeUndefined()
    expect(await services.tubes.get(tube.id)).toEqual(tube)

    const updated = await services.tubes.update(tube.id, {
      name: "Renamed",
      description: "d",
      enabled: false,
      schemaDefinition: PERSON,
    })
    expect(updated).toMatchObject({
      name: "Renamed",
      description: "d",
      enabled: false,
      schemaDefinition: PERSON,
    })
    const cleared = await services.tubes.update(tube.id, {
      description: null,
      schemaDefinition: null,
    })
    expect(cleared.description).toBeUndefined()
    expect(cleared.schemaDefinition).toBeUndefined()
  })

  it("requires an existing folder and valid input", async () => {
    await expect(
      services.tubes.create({ folderId: crypto.randomUUID(), name: "x" })
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      services.tubes.create({ folderId: "not-a-uuid", name: "x" })
    ).rejects.toBeInstanceOf(ZodError)
    const f = await services.folders.create({ name: "f" })
    await expect(
      services.tubes.create({ folderId: f.id, name: "" })
    ).rejects.toBeInstanceOf(ZodError)
    await expect(
      services.tubes.create({ folderId: f.id, name: "x", bogus: true })
    ).rejects.toBeInstanceOf(ZodError)
    const t = await services.tubes.create({ folderId: f.id, name: "x" })
    await expect(services.tubes.update(t.id, {})).rejects.toBeInstanceOf(
      ZodError
    )
    await expect(services.tubes.get("missing")).rejects.toBeInstanceOf(
      NotFoundError
    )
  })

  it("validates schemaDefinition as a JSON Schema on save", async () => {
    const f = await services.folders.create({ name: "f" })
    for (const bad of [
      { type: "nope" },
      { type: "object", required: "name" },
      { $ref: "#/$defs/missing" },
    ]) {
      await expect(
        services.tubes.create({
          folderId: f.id,
          name: "x",
          schemaDefinition: bad,
        })
      ).rejects.toBeInstanceOf(ValidationError)
    }
    await expect(
      services.tubes.create({ folderId: f.id, name: "x", schemaDefinition: [] })
    ).rejects.toBeInstanceOf(ZodError)
    const t = await services.tubes.create({
      folderId: f.id,
      name: "x",
      schemaDefinition: {
        $schema: "http://json-schema.org/draft-07/schema#",
        ...PERSON,
      },
    })
    await expect(
      services.tubes.update(t.id, { schemaDefinition: { type: 1 } })
    ).rejects.toBeInstanceOf(ValidationError)
    expect((await services.tubes.list()).page.total).toBe(1)

    expect(validateJsonSchema(PERSON, { name: "Ann", age: 3 })).toEqual([])
    expect(validateJsonSchema(PERSON, { age: "x" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "required" }),
        expect.objectContaining({ path: "/age", keyword: "type" }),
      ])
    )
  })

  it("lists tubes filtered by folder with pagination", async () => {
    const a = await services.folders.create({ name: "a" })
    const b = await services.folders.create({ name: "b" })
    await services.tubes.create({ folderId: a.id, name: "a1" })
    await services.tubes.create({ folderId: b.id, name: "b1" })
    await services.tubes.create({ folderId: a.id, name: "a2" })

    const inA = await services.tubes.list({ folderId: a.id })
    expect(inA.data.map((t) => t.name)).toEqual(["a1", "a2"])
    expect(inA.page.total).toBe(2)
    const page = await services.tubes.list({ limit: "1", offset: "2" })
    expect(page).toMatchObject({ page: { offset: 2, limit: 1, total: 3 } })
    expect(page.data.map((t) => t.name)).toEqual(["a2"])
  })

  it("moves tubes between folders (only into existing folders)", async () => {
    const a = await services.folders.create({ name: "a" })
    const b = await services.folders.create({ name: "b" })
    const t = await services.tubes.create({ folderId: a.id, name: "t" })

    const moved = await services.tubes.move(t.id, b.id)
    expect(moved.folderId).toBe(b.id)
    expect((await services.tubes.list({ folderId: a.id })).data).toEqual([])
    expect((await services.tubes.list({ folderId: b.id })).data).toEqual([
      moved,
    ])
    await expect(
      services.tubes.update(t.id, { folderId: crypto.randomUUID() })
    ).rejects.toBeInstanceOf(NotFoundError)
    expect((await services.tubes.get(t.id)).folderId).toBe(b.id)

    // Folder emptied by the move can now be deleted; the target cannot.
    await services.folders.delete(a.id)
    await expect(services.folders.delete(b.id)).rejects.toBeInstanceOf(
      ConflictError
    )
  })

  describe("delete only empty tubes", () => {
    it("rejects deleting a tube with live items", async () => {
      const f = await services.folders.create({ name: "f" })
      const t = await services.tubes.create({ folderId: f.id, name: "t" })
      await storage.items.create(makeItem(t.id))
      await expect(services.tubes.delete(t.id)).rejects.toBeInstanceOf(
        ConflictError
      )
      expect(await services.tubes.get(t.id)).toBeTruthy()
    })

    it("deletes a tube whose items are all soft-deleted (purging them)", async () => {
      const f = await services.folders.create({ name: "f" })
      const t = await services.tubes.create({ folderId: f.id, name: "t" })
      const item = await storage.items.create(
        makeItem(t.id, { deletedAt: new Date().toISOString() })
      )
      await services.tubes.delete(t.id)
      await expect(services.tubes.get(t.id)).rejects.toBeInstanceOf(
        NotFoundError
      )
      expect(await storage.items.get(item.id)).toBeNull()
      await expect(services.tubes.delete(t.id)).rejects.toBeInstanceOf(
        NotFoundError
      )
      // folder is now empty
      await services.folders.delete(f.id)
    })
  })

  it("creates, lists and moves top-level tubes (no folder)", async () => {
    const f = await services.folders.create({ name: "f" })
    const top = await services.tubes.create({ name: "Top" })
    expect(top.folderId).toBeNull()
    const explicit = await services.tubes.create({ folderId: null, name: "T2" })
    const inF = await services.tubes.create({ folderId: f.id, name: "inF" })

    const roots = await services.tubes.list({ folderId: null })
    expect(roots.data.map((t) => t.id)).toEqual([top.id, explicit.id])
    // query-string form (REST)
    expect((await services.tubes.list({ folderId: "null" })).page.total).toBe(2)

    const moved = await services.tubes.move(top.id, f.id)
    expect(moved.folderId).toBe(f.id)
    const back = await services.tubes.move(inF.id, null)
    expect(back.folderId).toBeNull()

    const { folders, tubes } = await services.folders.hierarchy()
    expect(tubes.map((t) => t.name).sort()).toEqual(["T2", "inF"])
    expect(folders[0].tubes.map((t) => t.name)).toEqual(["Top"])
    expect(await services.folders.tree()).toEqual(folders)
  })

  it("includes tubes as leaves in the folder tree", async () => {
    const a = await services.folders.create({ name: "a" })
    const b = await services.folders.create({ name: "b", parentId: a.id })
    await services.tubes.create({ folderId: a.id, name: "ta" })
    await services.tubes.create({ folderId: b.id, name: "tb" })

    const [root] = await services.folders.tree()
    expect(root.tubes.map((t) => t.name)).toEqual(["ta"])
    expect(root.children[0]).toMatchObject({ name: "b", children: [] })
    expect(root.children[0].tubes.map((t) => t.name)).toEqual(["tb"])
  })
})

describe("tube clone", () => {
  it("copies settings into the same folder with a default name", async () => {
    const f = await services.folders.create({ name: "f" })
    const source = await services.tubes.create({
      folderId: f.id,
      name: "Leads",
      description: "inbound",
      enabled: false,
      schemaDefinition: PERSON,
      retryPolicy: { maxAttempts: 7 },
    })
    await services.tubes.update(source.id, { enabled: true })
    await services.items.push(source.id, { payload: { name: "Ada" } })

    const { tube, items } = await services.tubes.clone(source.id)
    expect(items).toBe(0)
    expect(tube).toMatchObject({
      folderId: f.id,
      name: "Leads (copy)",
      description: "inbound",
      enabled: true,
      schemaDefinition: PERSON,
      retryPolicy: { maxAttempts: 7 },
    })
    expect(tube.id).not.toBe(source.id)
    expect((await services.items.list(tube.id)).page.total).toBe(0)
  })

  it("optionally copies non-deleted items as fresh pending items", async () => {
    const source = await services.tubes.create({ name: "src" })
    const a = (
      await services.items.push(source.id, {
        payload: { n: 1 },
        priority: 4,
        tags: ["x"],
        metadata: { m: 1 },
        idempotencyKey: "k1",
      })
    ).item
    await services.items.update(a.id, { status: "cancelled" })
    const gone = (await services.items.push(source.id, { payload: { n: 2 } }))
      .item
    await services.items.delete(gone.id)
    const target = await services.folders.create({ name: "target" })

    const { tube, items } = await services.tubes.clone(source.id, {
      name: "dst",
      folderId: target.id,
      includeItems: true,
    })
    expect(items).toBe(1)
    expect(tube).toMatchObject({ name: "dst", folderId: target.id })
    const [copy] = (await services.items.list(tube.id)).data
    expect(copy).toMatchObject({
      status: "pending",
      payload: { n: 1 },
      priority: 4,
      tags: ["x"],
      metadata: { m: 1 },
      idempotencyKey: "k1",
      attempts: 0,
    })
    expect(copy.id).not.toBe(a.id)
    const history = await services.items.history(copy.id)
    expect(history.data).toEqual([
      expect.objectContaining({
        action: "created",
        oldValue: { clonedFrom: a.id },
      }),
    ])
    // the source is untouched
    expect((await services.items.get(a.id)).status).toBe("cancelled")
  })

  it("rejects unknown tubes and folders", async () => {
    const source = await services.tubes.create({ name: "src" })
    await expect(services.tubes.clone(crypto.randomUUID())).rejects.toThrow(
      NotFoundError
    )
    await expect(
      services.tubes.clone(source.id, { folderId: crypto.randomUUID() })
    ).rejects.toThrow(NotFoundError)
    await expect(services.tubes.clone(source.id, { name: "" })).rejects.toThrow(
      ZodError
    )
  })
})

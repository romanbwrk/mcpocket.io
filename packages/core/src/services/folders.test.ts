import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ZodError } from "zod"

import { ConflictError, NotFoundError } from "../domain/errors"
import { createServiceContext, createServices } from "./index"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"
import { makeTube } from "../storage/testing/contract"

let dataDir: string
let storage: Storage
let folders: ReturnType<typeof createServices>["folders"]

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-folders-"))
  storage = await createJsonStorage({ dataDir })
  folders = createServices(createServiceContext(storage), {
    kind: "api_key",
    id: "test",
  }).folders
})
afterEach(async () => {
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe("folder service", () => {
  it("creates, reads, renames and describes folders with unlimited nesting", async () => {
    let parent = await folders.create({ name: "Root" })
    expect(parent).toMatchObject({ name: "Root", parentId: null })
    for (let depth = 1; depth <= 12; depth++) {
      parent = await folders.create({ name: `L${depth}`, parentId: parent.id })
    }
    expect(await folders.get(parent.id)).toEqual(parent)

    const renamed = await folders.update(parent.id, {
      name: "Renamed",
      description: "Deep",
    })
    expect(renamed).toMatchObject({ name: "Renamed", description: "Deep" })
    const cleared = await folders.update(parent.id, { description: null })
    expect(cleared.description).toBeUndefined()
  })

  it("validates input (Zod) and rejects unknown parents", async () => {
    await expect(folders.create({ name: "" })).rejects.toBeInstanceOf(ZodError)
    await expect(
      folders.create({ name: "x", bogus: 1 })
    ).rejects.toBeInstanceOf(ZodError)
    await expect(
      folders.create({ name: "x", parentId: crypto.randomUUID() })
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(folders.get("missing")).rejects.toBeInstanceOf(NotFoundError)
    const f = await folders.create({ name: "a" })
    await expect(folders.update(f.id, {})).rejects.toBeInstanceOf(ZodError)
  })

  it("lists by parent with pagination", async () => {
    const a = await folders.create({ name: "a" })
    await folders.create({ name: "b" })
    await folders.create({ name: "a1", parentId: a.id })
    await folders.create({ name: "a2", parentId: a.id })

    const roots = await folders.list({ parentId: null })
    expect(roots.data.map((f) => f.name)).toEqual(["a", "b"])
    const page = await folders.list({ parentId: a.id, limit: "1", offset: "1" })
    expect(page).toMatchObject({ page: { offset: 1, limit: 1, total: 2 } })
    expect(page.data.map((f) => f.name)).toEqual(["a2"])
    expect((await folders.list()).page.total).toBe(4)
  })

  describe("move (cycle prevention)", () => {
    it("moves a folder under another folder and back to the root", async () => {
      const a = await folders.create({ name: "a" })
      const b = await folders.create({ name: "b" })
      expect((await folders.update(b.id, { parentId: a.id })).parentId).toBe(
        a.id
      )
      expect((await folders.update(b.id, { parentId: null })).parentId).toBe(
        null
      )
    })

    it("rejects moving a folder into itself", async () => {
      const a = await folders.create({ name: "a" })
      await expect(
        folders.update(a.id, { parentId: a.id })
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it("rejects moving a folder into a descendant", async () => {
      const a = await folders.create({ name: "a" })
      const b = await folders.create({ name: "b", parentId: a.id })
      const c = await folders.create({ name: "c", parentId: b.id })
      for (const target of [b, c]) {
        await expect(
          folders.update(a.id, { parentId: target.id })
        ).rejects.toBeInstanceOf(ConflictError)
      }
      expect((await folders.get(a.id)).parentId).toBeNull()
    })

    it("rejects moving into a missing folder", async () => {
      const a = await folders.create({ name: "a" })
      await expect(
        folders.update(a.id, { parentId: crypto.randomUUID() })
      ).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe("delete only empty folders", () => {
    it("deletes an empty folder", async () => {
      const a = await folders.create({ name: "a" })
      await folders.delete(a.id)
      await expect(folders.get(a.id)).rejects.toBeInstanceOf(NotFoundError)
      await expect(folders.delete(a.id)).rejects.toBeInstanceOf(NotFoundError)
    })

    it("rejects deleting a folder with subfolders", async () => {
      const a = await folders.create({ name: "a" })
      await folders.create({ name: "b", parentId: a.id })
      await expect(folders.delete(a.id)).rejects.toBeInstanceOf(ConflictError)
      expect(await folders.get(a.id)).toBeTruthy()
    })

    it("rejects deleting a folder with tubes", async () => {
      const a = await folders.create({ name: "a" })
      await storage.tubes.create(makeTube(a.id))
      await expect(folders.delete(a.id)).rejects.toBeInstanceOf(ConflictError)
    })
  })

  it("builds the full nested tree", async () => {
    const a = await folders.create({ name: "a" })
    const b = await folders.create({ name: "b", parentId: a.id })
    await folders.create({ name: "c", parentId: b.id })
    await folders.create({ name: "d" })

    const tree = await folders.tree()
    expect(tree.map((n) => n.name)).toEqual(["a", "d"])
    expect(tree[0].children[0]).toMatchObject({ name: "b" })
    expect(tree[0].children[0].children[0]).toMatchObject({
      name: "c",
      children: [],
    })
  })
})

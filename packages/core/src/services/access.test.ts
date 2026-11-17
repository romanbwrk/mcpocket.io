import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AccessScope, Role } from "../domain/access"
import type { Actor } from "../domain/actor"
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../domain/errors"
import type { Folder, Item, Tube } from "../domain/schemas"
import {
  createServiceContext,
  createServices,
  type Services,
} from "./index"
import { EventBus } from "../events/bus"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

let dataDir: string
let storage: Storage
let admin: Services

/**
 * Tree:  A ─ A1 ─ tA1
 *        │    └ tA (in A)
 *        B ─ tB, tB2
 */
let A: Folder, A1: Folder, B: Folder
let tA: Tube, tA1: Tube, tB: Tube, tB2: Tube
let iA: Item, iA1: Item, iB: Item

const as = (role: Role, scope: AccessScope | null = null, agent = false) => {
  const actor: Actor = agent
    ? { kind: "agent", id: "bot", viaKeyId: "k", access: { role, scope } }
    : { kind: "api_key", id: "k", access: { role, scope } }
  return createServices(
    createServiceContext(storage, { events: new EventBus() }),
    actor
  )
}
const scope = (folderIds: string[] = [], tubeIds: string[] = []) => ({
  folderIds,
  tubeIds,
})

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-access-"))
  storage = await createJsonStorage({ dataDir })
  admin = createServices(
    createServiceContext(storage, { events: new EventBus() }),
    { kind: "system", id: "test" }
  )
  A = await admin.folders.create({ name: "A" })
  A1 = await admin.folders.create({ name: "A1", parentId: A.id })
  B = await admin.folders.create({ name: "B" })
  tA = await admin.tubes.create({ folderId: A.id, name: "tA" })
  tA1 = await admin.tubes.create({ folderId: A1.id, name: "tA1" })
  tB = await admin.tubes.create({ folderId: B.id, name: "tB" })
  tB2 = await admin.tubes.create({ folderId: B.id, name: "tB2" })
  iA = (await admin.items.push(tA.id, { payload: { n: 1 } })).item
  iA1 = (await admin.items.push(tA1.id, { payload: { n: 2 } })).item
  iB = (await admin.items.push(tB.id, { payload: { n: 3 } })).item
})
afterEach(async () => {
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

const ids = (list: { id: string }[]) => list.map((x) => x.id).sort()

describe("roles", () => {
  it("readonly can read but not write anything", async () => {
    const ro = as("readonly")
    expect((await ro.folders.list()).page.total).toBe(3)
    expect((await ro.items.get(iA.id)).id).toBe(iA.id)
    await expect(ro.folders.create({ name: "x" })).rejects.toThrow(
      ForbiddenError
    )
    await expect(ro.tubes.update(tA.id, { name: "x" })).rejects.toThrow(
      ForbiddenError
    )
    await expect(ro.items.push(tA.id, { payload: {} })).rejects.toThrow(
      ForbiddenError
    )
    await expect(ro.items.update(iA.id, { priority: 1 })).rejects.toThrow(
      ForbiddenError
    )
    await expect(ro.items.delete(iA.id)).rejects.toThrow(ForbiddenError)
    await expect(ro.apiKeys.list()).rejects.toThrow(ForbiddenError)
    const err = await ro.folders.delete(B.id).catch((e) => e)
    expect(err).toMatchObject({
      code: "forbidden",
      details: { capability: "structure:manage", role: "readonly" },
    })
  })

  it("agent can push and process but not manage items or structure", async () => {
    const bot = as("agent", null, true)
    await bot.items.push(tA.id, { payload: { ok: true } })
    const claim = await bot.processing.claim({ tubeId: tA.id })
    expect(claim?.item.assignedAgent).toBe("bot")
    await bot.processing.complete(claim!.item.id, { result: 1 })
    await expect(bot.items.update(iA.id, { priority: 2 })).rejects.toThrow(
      ForbiddenError
    )
    await expect(
      bot.items.bulkUpdate({ ids: [iA.id], patch: { priority: 2 } })
    ).rejects.toThrow(ForbiddenError)
    await expect(
      bot.items.reassign(iA.id, { agentId: "other" })
    ).rejects.toThrow(ForbiddenError)
    await expect(
      bot.tubes.create({ folderId: A.id, name: "x" })
    ).rejects.toThrow(ForbiddenError)
  })

  it("operator manages data and structure but not access", async () => {
    const op = as("operator")
    const f = await op.folders.create({ name: "new" })
    await op.tubes.create({ folderId: f.id, name: "t" })
    await op.items.update(iA.id, { priority: 5 })
    await expect(
      op.apiKeys.create({ id: "x", role: "readonly" })
    ).rejects.toThrow(ForbiddenError)
    await expect(op.apiKeys.auditLog()).rejects.toThrow(ForbiddenError)
  })

  it("readonly cannot claim even with an agent identity", async () => {
    await expect(
      as("readonly", null, true).processing.claim({ tubeId: tA.id })
    ).rejects.toThrow(ForbiddenError)
  })
})

describe("folder scope (inherited down the tree)", () => {
  it("lists only what the caller can see; ancestors are navigation only", async () => {
    const op = as("operator", scope([A1.id]))
    // A is visible (ancestor of A1), B is not
    expect(ids((await op.folders.list()).data)).toEqual(ids([A, A1]))
    expect(ids((await op.folders.list({ parentId: null })).data)).toEqual([
      A.id,
    ])
    // tA lives in A (ancestor only) → not accessible
    expect(ids((await op.tubes.list()).data)).toEqual([tA1.id])
    await expect(op.tubes.list({ folderId: B.id })).rejects.toThrow(
      NotFoundError
    )
    const tree = await op.folders.tree()
    expect(tree.map((n) => n.name)).toEqual(["A"])
    expect(tree[0].tubes).toEqual([])
    expect(tree[0].children.map((n) => n.name)).toEqual(["A1"])
    expect(tree[0].children[0].tubes.map((t) => t.name)).toEqual(["tA1"])
  })

  it("inherits access to subfolders created later", async () => {
    const op = as("operator", scope([A.id]))
    const deep = await op.folders.create({ name: "deep", parentId: A1.id })
    const t = await op.tubes.create({ folderId: deep.id, name: "deep-t" })
    expect((await op.items.push(t.id, { payload: {} })).created).toBe(true)
    expect(ids((await op.tubes.list()).data)).toEqual(ids([tA, tA1, t]))
  })

  it("hides out-of-scope entities as 404 and forbids writes on ancestors", async () => {
    const op = as("operator", scope([A1.id]))
    await expect(op.folders.get(B.id)).rejects.toThrow(NotFoundError)
    await expect(op.tubes.get(tB.id)).rejects.toThrow(NotFoundError)
    await expect(op.items.get(iB.id)).rejects.toThrow(NotFoundError)
    await expect(op.items.history(iB.id)).rejects.toThrow(NotFoundError)
    await expect(op.items.get(iA.id)).rejects.toThrow(NotFoundError)
    await expect(op.items.update(iB.id, { priority: 1 })).rejects.toThrow(
      NotFoundError
    )
    // visible ancestor A: readable, not writable
    expect((await op.folders.get(A.id)).id).toBe(A.id)
    await expect(op.folders.update(A.id, { name: "x" })).rejects.toThrow(
      ForbiddenError
    )
    await expect(
      op.tubes.create({ folderId: A.id, name: "x" })
    ).rejects.toThrow(ForbiddenError)
    // no root writes, no moves out of scope
    await expect(op.folders.create({ name: "root" })).rejects.toThrow(
      ForbiddenError
    )
    await expect(op.tubes.move(tA1.id, B.id)).rejects.toThrow(NotFoundError)
    await expect(op.folders.update(A1.id, { parentId: null })).rejects.toThrow(
      ForbiddenError
    )
    // bulk: out-of-scope entries fail individually
    const bulk = await op.items.bulkUpdate({
      ids: [iA1.id, iB.id],
      patch: { priority: 3 },
    })
    expect(bulk.summary).toMatchObject({ succeeded: 1, failed: 1 })
    expect(bulk.results[1]).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    })
  })

  it("scopes search, agent items and statistics", async () => {
    const op = as("operator", scope([A1.id]))
    expect(ids((await op.items.search()).data)).toEqual([iA1.id])
    expect(
      ids(
        (
          await op.items.search({
            payload: [{ path: "n", op: "gte", value: 0 }],
          })
        ).data
      )
    ).toEqual([iA1.id])
    const stats = await op.statistics.global()
    expect(stats).toMatchObject({ folders: 2, tubes: 1, counts: { total: 1 } })
    await expect(op.statistics.tube(tB.id)).rejects.toThrow(NotFoundError)

    await admin.items.reassign(iB.id, { agentId: "x" })
    await admin.items.reassign(iA1.id, { agentId: "x" })
    expect(ids((await op.processing.agentItems("x")).data)).toEqual([iA1.id])
    const agents = await op.statistics.agents()
    expect(agents.data).toEqual([
      expect.objectContaining({ agentId: "x", assigned: 1 }),
    ])
  })
})

describe("tube scope", () => {
  it("grants single tubes and shows their folder path", async () => {
    const bot = as("agent", scope([], [tB2.id]), true)
    expect(ids((await bot.tubes.list()).data)).toEqual([tB2.id])
    expect(ids((await bot.folders.list()).data)).toEqual([B.id])
    await expect(bot.processing.claim({ tubeId: tB.id })).rejects.toThrow(
      NotFoundError
    )
    await bot.items.push(tB2.id, { payload: { x: 1 } })
    const claim = await bot.processing.claim({ tubeId: tB2.id })
    expect(claim?.item.tubeId).toBe(tB2.id)
    const tree = await bot.folders.tree()
    expect(tree.map((n) => [n.name, n.tubes.map((t) => t.name)])).toEqual([
      ["B", ["tB2"]],
    ])
  })

  it("handles top-level tubes: only explicit tube scope grants them", async () => {
    const top = await admin.tubes.create({ name: "top" })
    const folderScoped = as("operator", scope([B.id]))
    expect(ids((await folderScoped.tubes.list()).data)).not.toContain(top.id)
    await expect(folderScoped.tubes.get(top.id)).rejects.toThrow(NotFoundError)
    expect((await folderScoped.folders.hierarchy()).tubes).toEqual([])
    // scoped keys cannot create or move tubes to the top level
    await expect(folderScoped.tubes.create({ name: "x" })).rejects.toThrow(
      ForbiddenError
    )
    await expect(folderScoped.tubes.move(tB.id, null)).rejects.toThrow(
      ForbiddenError
    )

    const tubeScoped = as("agent", scope([], [top.id]), true)
    expect(ids((await tubeScoped.tubes.list()).data)).toEqual([top.id])
    expect(ids((await tubeScoped.tubes.list({ folderId: null })).data)).toEqual(
      [top.id]
    )
    const h = await tubeScoped.folders.hierarchy()
    expect(h.folders).toEqual([])
    expect(h.tubes.map((t) => t.id)).toEqual([top.id])
    await tubeScoped.items.push(top.id, { payload: { x: 1 } })
    expect(
      (await tubeScoped.processing.claim({ tubeId: top.id }))?.item.tubeId
    ).toBe(top.id)
  })

  it("loses access to a lease when the tube leaves the scope", async () => {
    const wide = as("agent", scope([B.id]), true)
    const claim = await wide.processing.claim({ tubeId: tB.id })
    const narrow = as("agent", scope([], [tB2.id]), true)
    await expect(
      narrow.processing.complete(claim!.item.id, {})
    ).rejects.toThrow(NotFoundError)
  })
})

describe("admins are never scoped", () => {
  it("ignores a scope on the admin role", async () => {
    const a = as("admin", scope([A1.id]))
    expect((await a.tubes.list()).page.total).toBe(4)
  })

  it("rejects scoping an admin key", async () => {
    await expect(
      admin.apiKeys.create({ id: "a", role: "admin", scope: scope([A.id]) })
    ).rejects.toThrow(ValidationError)
  })
})

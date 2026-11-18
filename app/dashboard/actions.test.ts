import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  adminConfigFromEnv,
  createSessionToken,
  SESSION_COOKIE,
} from "@mcpocket/core/auth/session"
import { cookieJar, nextCacheMock, RedirectError } from "@/lib/auth/test-utils"
import type { ActionResult } from "@/lib/dashboard/explorer"
import { getServices } from "@mcpocket/core/services"
import { resetStorageSingleton } from "@mcpocket/core/storage"

import {
  createFolderAction,
  createTubeAction,
  deleteFolderAction,
  deleteItemAction,
  deleteTubeAction,
  moveFolderAction,
  moveTubeAction,
  reassignItemAction,
  updateItemAction,
  updateFolderAction,
  updateTubeAction,
} from "./actions"

vi.mock("server-only", () => ({}))
vi.mock(
  "next/headers",
  async () => (await import("@/lib/auth/test-utils")).nextHeadersMock
)
vi.mock(
  "next/navigation",
  async () => (await import("@/lib/auth/test-utils")).nextNavigationMock
)
vi.mock(
  "next/cache",
  async () => (await import("@/lib/auth/test-utils")).nextCacheMock
)

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-dash-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_ADMIN_USERNAME", "boss")
  vi.stubEnv("MCPOCKET_ADMIN_PASSWORD", "pw-123456")
  vi.stubEnv("MCPOCKET_SESSION_SECRET", "s".repeat(40))
  await resetStorageSingleton()
  cookieJar.clear()
  nextCacheMock.revalidatePath.mockClear()
})
afterEach(async () => {
  await resetStorageSingleton()
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

function login() {
  const { token } = createSessionToken(adminConfigFromEnv())
  cookieJar.set(SESSION_COOKIE, { value: token })
}

function ok<T>(result: ActionResult<T>): T {
  if (!result.ok)
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.data
}

describe("dashboard server actions", () => {
  it("redirect to /login without a valid session and do not write", async () => {
    await expect(createFolderAction({ name: "X" })).rejects.toBeInstanceOf(
      RedirectError
    )
    cookieJar.set(SESSION_COOKIE, { value: "v1.forged.sig" })
    await expect(createFolderAction({ name: "X" })).rejects.toMatchObject({
      url: "/login",
    })
    const services = await getServices({ kind: "system", id: "test" })
    expect((await services.folders.list()).page.total).toBe(0)
    expect(nextCacheMock.revalidatePath).not.toHaveBeenCalled()
  })

  it("create / rename / move folders through the services and revalidate the tree", async () => {
    login()
    const sales = ok(await createFolderAction({ name: "Sales" }))
    const inbound = ok(
      await createFolderAction({ name: "Inbound", parentId: sales.id })
    )
    expect(inbound.parentId).toBe(sales.id)
    expect(nextCacheMock.revalidatePath).toHaveBeenCalledWith(
      "/dashboard",
      "layout"
    )

    const renamed = ok(
      await updateFolderAction(inbound.id, { name: "Leads", description: "d" })
    )
    expect(renamed).toMatchObject({ name: "Leads", description: "d" })

    const moved = ok(await moveFolderAction(inbound.id, null))
    expect(moved.parentId).toBeNull()
  })

  it("return service errors (validation, cycle, non-empty delete) instead of throwing", async () => {
    login()
    const a = ok(await createFolderAction({ name: "A" }))
    const b = ok(await createFolderAction({ name: "B", parentId: a.id }))

    const invalid = await createFolderAction({ name: "   " })
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    })

    const cycle = await moveFolderAction(a.id, b.id)
    expect(cycle).toMatchObject({ ok: false, error: { code: "conflict" } })
    if (!cycle.ok) expect(cycle.error.message).toMatch(/descendants/)

    const notEmpty = await deleteFolderAction(a.id)
    expect(notEmpty).toMatchObject({ ok: false, error: { code: "conflict" } })

    expect(ok(await deleteFolderAction(b.id))).toEqual({ id: b.id })
    const missing = await deleteFolderAction(b.id)
    expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } })
  })

  it("create / move / delete tubes; a tube with items cannot be deleted", async () => {
    login()
    const a = ok(await createFolderAction({ name: "A" }))
    const b = ok(await createFolderAction({ name: "B" }))
    const tube = ok(
      await createTubeAction({ folderId: a.id, name: "Leads", enabled: false })
    )
    expect(tube).toMatchObject({ folderId: a.id, enabled: false })

    expect(ok(await moveTubeAction(tube.id, b.id)).folderId).toBe(b.id)
    expect(await moveTubeAction(tube.id, "not-an-id")).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    })

    const t2 = ok(await createTubeAction({ folderId: b.id, name: "Orders" }))
    const services = await getServices({ kind: "system", id: "test" })
    await services.items.push(t2.id, { payload: { n: 1 } })
    expect(await deleteTubeAction(t2.id)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    })
    expect(ok(await deleteTubeAction(tube.id))).toEqual({ id: tube.id })
  })

  it("edit tube settings (tube view): name, description, enabled, schema", async () => {
    login()
    const folder = ok(await createFolderAction({ name: "A" }))
    const tube = ok(
      await createTubeAction({
        folderId: folder.id,
        name: "Leads",
        description: "old",
      })
    )
    const schema = { type: "object", required: ["email"] }
    const updated = ok(
      await updateTubeAction(tube.id, {
        name: "Hot leads",
        description: null,
        enabled: false,
        schemaDefinition: schema,
      })
    )
    expect(updated).toMatchObject({
      name: "Hot leads",
      enabled: false,
      schemaDefinition: schema,
    })
    expect(updated.description).toBeUndefined()

    // invalid JSON Schema → validation error with details, nothing written
    const invalid = await updateTubeAction(tube.id, {
      schemaDefinition: { type: "nope" },
    })
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    })
    if (!invalid.ok) expect(invalid.error.details).toBeTruthy()

    // the schema is enforced on push; null clears it
    const services = await getServices({ kind: "system", id: "test" })
    await expect(
      services.items.push(tube.id, { payload: { n: 1 } })
    ).rejects.toMatchObject({ code: "conflict" }) // disabled
    ok(await updateTubeAction(tube.id, { enabled: true }))
    await expect(
      services.items.push(tube.id, { payload: { n: 1 } })
    ).rejects.toMatchObject({ code: "validation_error" })
    const cleared = ok(
      await updateTubeAction(tube.id, { schemaDefinition: null })
    )
    expect(cleared.schemaDefinition).toBeUndefined()
    await expect(
      services.items.push(tube.id, { payload: { n: 1 } })
    ).resolves.toMatchObject({ created: true })
  })
  it("item inspector: edit payload, change status, reassign, delete — all audited as the user", async () => {
    login()
    const folder = ok(await createFolderAction({ name: "A" }))
    const tube = ok(
      await createTubeAction({
        folderId: folder.id,
        name: "T",
        schemaDefinition: { type: "object", required: ["email"] },
      })
    )
    const services = await getServices({ kind: "system", id: "test" })
    const { item } = await services.items.push(tube.id, {
      payload: { email: "a@b.c" },
    })

    const bad = await updateItemAction(item.id, { payload: { name: "x" } })
    expect(bad).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    })
    ok(await updateItemAction(item.id, { payload: { email: "x@y.z" } }))
    expect(
      await updateItemAction(item.id, { status: "processing" })
    ).toMatchObject({ ok: false, error: { code: "validation_error" } })
    ok(await updateItemAction(item.id, { status: "cancelled" }))
    ok(await reassignItemAction(item.id, "bot-3"))
    const deleted = ok(await deleteItemAction(item.id))
    expect(deleted.deletedAt).toBeTruthy()
    expect(await deleteItemAction(item.id)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    })
    expect(nextCacheMock.revalidatePath).toHaveBeenCalled()

    const history = await services.items.history(item.id)
    expect(history.data.map((e) => [e.action, e.actor])).toEqual([
      ["deleted", "user:boss"],
      ["reassigned", "user:boss"],
      ["status_changed", "user:boss"],
      ["updated", "user:boss"],
      ["created", "system:test"],
    ])
  })
})

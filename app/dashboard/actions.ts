"use server"

import { revalidatePath } from "next/cache"

import { getUserServices } from "@/lib/auth/server"
import type { ActionResult } from "@/lib/dashboard/explorer"
import type { Folder, Item, Tube } from "@mcpocket/core/domain/schemas"
import type { Services } from "@mcpocket/core/services"
import type {
  BulkResult,
  RequeueAllResult,
} from "@mcpocket/core/services/items"
import { normalizeError } from "@mcpocket/core/services/errors"
import type { CloneTubeResult } from "@mcpocket/core/services/tubes"

/**
 * Dashboard server actions. Each one verifies the admin session (redirects
 * to /login otherwise), calls the same application services as REST/MCP with
 * a `user:<name>` actor, revalidates the dashboard layout (folder tree) and
 * returns an `ActionResult` so dialogs can show service errors (validation,
 * cycle, non-empty delete, ...) verbatim. Inputs are `unknown`: the services
 * validate them.
 */
async function run<T>(
  fn: (services: Services) => Promise<T>
): Promise<ActionResult<T>> {
  const services = await getUserServices()
  try {
    const data = await fn(services)
    revalidatePath("/dashboard", "layout")
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: normalizeError(error) }
  }
}

/** `{ name, description?, parentId: id | null }` */
export async function createFolderAction(
  input: unknown
): Promise<ActionResult<Folder>> {
  return run((s) => s.folders.create(input))
}

/** Rename / describe: `{ name?, description? (null clears) }`. */
export async function updateFolderAction(
  id: string,
  input: unknown
): Promise<ActionResult<Folder>> {
  return run((s) => s.folders.update(id, input))
}

/** `parentId: null` moves to the root. Cycles → `conflict`. */
export async function moveFolderAction(
  id: string,
  parentId: string | null
): Promise<ActionResult<Folder>> {
  return run((s) => s.folders.update(id, { parentId }))
}

/** Non-empty folder → `conflict`. */
export async function deleteFolderAction(
  id: string
): Promise<ActionResult<{ id: string }>> {
  return run(async (s) => {
    await s.folders.delete(id)
    return { id }
  })
}

/** `{ folderId, name, description?, enabled?, schemaDefinition? }` */
export async function createTubeAction(
  input: unknown
): Promise<ActionResult<Tube>> {
  return run((s) => s.tubes.create(input))
}

/** Any tube setting (name, description, enabled, schemaDefinition, folderId). */
export async function updateTubeAction(
  id: string,
  input: unknown
): Promise<ActionResult<Tube>> {
  return run((s) => s.tubes.update(id, input))
}

/** `folderId: null` moves the tube to the top level. */
export async function moveTubeAction(
  id: string,
  folderId: string | null
): Promise<ActionResult<Tube>> {
  return run((s) => s.tubes.move(id, folderId))
}

/** Tube with items → `conflict`. */
export async function deleteTubeAction(
  id: string
): Promise<ActionResult<{ id: string }>> {
  return run(async (s) => {
    await s.tubes.delete(id)
    return { id }
  })
}

// ── Items (inspector, ticket 12) ─────────────────────────────────────────

/**
 * Same rules as `PATCH /api/items/{id}` / MCP `update_item`: `{ payload?,
 * metadata?, tags?, priority?, status? }`. Invalid transitions → `conflict`,
 * schema violations → `validation_error` (details per payload path).
 */
export async function updateItemAction(
  id: string,
  input: unknown
): Promise<ActionResult<Item>> {
  return run((s) => s.items.update(id, input))
}

/** `agentId: null` unassigns (rejected while processing). */
export async function reassignItemAction(
  id: string,
  agentId: string | null
): Promise<ActionResult<Item>> {
  return run((s) => s.items.reassign(id, { agentId }))
}

/** Soft delete (history kept). */
export async function deleteItemAction(
  id: string
): Promise<ActionResult<Item>> {
  return run((s) => s.items.delete(id))
}

/**
 * Same rules as `POST /api/tubes/{id}/items/bulk`: `{ items: PushItemInput[] }`
 * (≤ 500 entries), one transaction, per-entry results. The import dialog
 * splits larger imports into several calls.
 */
export async function bulkPushItemsAction(
  tubeId: string,
  input: unknown
): Promise<ActionResult<BulkResult>> {
  return run((s) => s.items.bulkPush(tubeId, input))
}

/**
 * Resets a tube: matching items back to a fresh `pending` (see
 * `items.requeueAll`); `input` takes item filters, e.g. `{ status: ["failed"] }`.
 */
export async function resetTubeAction(
  tubeId: string,
  input: unknown = {}
): Promise<ActionResult<RequeueAllResult>> {
  return run((s) => s.items.requeueAll(tubeId, input))
}

/** `{ name?, folderId?, includeItems? }` — see `tubes.clone`. */
export async function cloneTubeAction(
  id: string,
  input: unknown
): Promise<ActionResult<CloneTubeResult>> {
  return run((s) => s.tubes.clone(id, input))
}

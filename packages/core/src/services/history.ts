import { actorToString, type Actor } from "../domain/actor"
import type { HistoryEvent } from "../domain/schemas"
import type { Repositories } from "../storage"

import type { ServiceContext } from "./context"

/** Audit actions written by services (processing: claimed … heartbeat). */
export type HistoryAction =
  | "created"
  | "updated"
  | "status_changed"
  | "deleted"
  | "claimed"
  | "completed"
  | "failed"
  | "released"
  | "heartbeat"
  | "reassigned"
  | (string & {})

/**
 * Appends one audit event. Call it with the `repos` of the surrounding
 * `storage.transaction`, so the item write and its history event are
 * committed together under the same mutex hold.
 */
export function recordHistory(
  ctx: ServiceContext,
  repos: Repositories,
  actor: Actor,
  event: {
    itemId: string
    action: HistoryAction
    oldValue?: unknown
    newValue?: unknown
    at?: string
  }
): Promise<HistoryEvent> {
  const { itemId, action, oldValue, newValue, at } = event
  return repos.history.append({
    id: ctx.newId(),
    itemId,
    action,
    ...(oldValue !== undefined && { oldValue }),
    ...(newValue !== undefined && { newValue }),
    actor: actorToString(actor),
    createdAt: at ?? ctx.clock.now().toISOString(),
  })
}

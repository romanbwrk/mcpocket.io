import { AsyncLocalStorage } from "node:async_hooks"

import { actorToString, type Actor } from "../domain/actor"
import type { Folder, Item, Tube } from "../domain/schemas"
import type {
  DomainEventInput,
  FolderEvent,
  ItemEvent,
  TubeEvent,
} from "../events/types"
import type { Repositories } from "../storage"

import type { ServiceContext } from "./context"
import { enqueueWebhookDeliveries } from "./webhook-outbox"

/**
 * Events emitted inside `transact` are buffered here and published only after
 * the OUTERMOST `transact` commits — a rolled-back write publishes nothing,
 * and bulk operations publish their events after their single persist.
 */
const pending = new AsyncLocalStorage<DomainEventInput[]>()

/**
 * `storage.transaction` + domain events: use it for every service write.
 * Nested calls join the outer buffer (and the outer storage transaction).
 *
 * Webhook outbox (ticket 17): when `fn` succeeds, the buffered item events
 * are turned into webhook delivery rows still INSIDE the transaction, so they
 * commit atomically with the change (and vanish with it on rollback).
 */
export async function transact<T>(
  ctx: ServiceContext,
  fn: (repos: Repositories) => Promise<T>
): Promise<T> {
  if (pending.getStore()) return ctx.storage.transaction(fn)
  const buffer: DomainEventInput[] = []
  const result = await pending.run(buffer, () =>
    ctx.storage.transaction(async (repos) => {
      const value = await fn(repos)
      await enqueueWebhookDeliveries(ctx, repos, buffer)
      return value
    })
  )
  for (const event of buffer) ctx.events.publish(event)
  return result
}

/** Queues an event for publication after commit (or publishes it now outside `transact`). */
export function emit(ctx: ServiceContext, event: DomainEventInput): void {
  const buffer = pending.getStore()
  if (buffer) buffer.push(event)
  else ctx.events.publish(event)
}

/**
 * One event per item write. Type: `created` (no `before`), `deleted`
 * (deletedAt newly set), `status_changed` (status differs), else `updated`.
 */
export function itemEvent(
  actor: Actor,
  action: string,
  before: Item | null,
  after: Item
): Omit<ItemEvent, "seq"> {
  const type: ItemEvent["type"] = !before
    ? "item.created"
    : after.deletedAt && !before.deletedAt
      ? "item.deleted"
      : after.status !== before.status
        ? "item.status_changed"
        : "item.updated"
  return {
    type,
    action,
    at: after.updatedAt,
    actor: actorToString(actor),
    itemId: after.id,
    tubeId: after.tubeId,
    status: after.status,
    ...(before && before.status !== after.status
      ? { previousStatus: before.status }
      : {}),
    assignedAgent: after.assignedAgent ?? null,
  }
}

export function folderEvent(
  actor: Actor,
  type: FolderEvent["type"],
  folder: Folder,
  at: string
): Omit<FolderEvent, "seq"> {
  return {
    type,
    at,
    actor: actorToString(actor),
    folderId: folder.id,
    parentId: folder.parentId,
  }
}

export function tubeEvent(
  actor: Actor,
  type: TubeEvent["type"],
  tube: Tube,
  at: string
): Omit<TubeEvent, "seq"> {
  return {
    type,
    at,
    actor: actorToString(actor),
    tubeId: tube.id,
    folderId: tube.folderId,
  }
}

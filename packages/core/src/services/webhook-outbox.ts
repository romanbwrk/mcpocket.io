import type {
  Webhook,
  WebhookDelivery,
  WebhookEventType,
} from "../domain/schemas"
import type { DomainEventInput, ItemEvent } from "../events/types"
import type { Repositories } from "../storage"

import type { ServiceContext } from "./context"

/**
 * Transactional outbox (ticket 17). `transact` calls
 * `enqueueWebhookDeliveries` with the domain events buffered by the write,
 * INSIDE the same storage transaction, right before it commits: the outbox
 * rows are persisted together with the item change (one mutex hold, one
 * persist) or not at all on rollback. The background dispatcher
 * (webhook-dispatcher.ts) then delivers them; nothing depends on the
 * in-memory event bus, which is lossy.
 */

/** The JSON body POSTed to subscribers (and stored on the delivery row). */
export type WebhookPayload = {
  /** Event id: identical for every subscription receiving this event. */
  id: string
  type: string
  createdAt: string
  data: Record<string, unknown>
}

type ItemEventInput = Omit<ItemEvent, "seq">

const isItemEvent = (event: DomainEventInput): event is ItemEventInput =>
  event.type.startsWith("item.")

/** Folder ids from `folderId` up to the root (cycle-safe). */
async function folderPath(
  repos: Repositories,
  folderId: string | null,
  cache: Map<string, string | null>
): Promise<string[]> {
  const path: string[] = []
  let current: string | null = folderId
  while (current && !path.includes(current) && path.length < 1000) {
    path.push(current)
    if (!cache.has(current)) {
      cache.set(current, (await repos.folders.get(current))?.parentId ?? null)
    }
    current = cache.get(current) ?? null
  }
  return path
}

/** Does `webhook` want this event (type + folder/tube scope)? */
export function webhookMatches(
  webhook: Pick<Webhook, "enabled" | "eventTypes" | "folderId" | "tubeId">,
  event: { type: string; tubeId: string },
  tubeFolderPath: string[]
): boolean {
  if (!webhook.enabled) return false
  if (
    webhook.eventTypes.length > 0 &&
    !webhook.eventTypes.includes(event.type as WebhookEventType)
  ) {
    return false
  }
  if (webhook.tubeId && webhook.tubeId !== event.tubeId) return false
  if (webhook.folderId && !tubeFolderPath.includes(webhook.folderId)) {
    return false
  }
  return true
}

export function newDelivery(
  ctx: ServiceContext,
  webhookId: string,
  payload: WebhookPayload,
  at: string
): WebhookDelivery {
  return {
    id: ctx.newId(),
    webhookId,
    eventId: payload.id,
    eventType: payload.type,
    payload,
    status: "pending",
    attempts: 0,
    nextAttemptAt: at,
    lastAttemptAt: null,
    deliveredAt: null,
    lastError: null,
    attemptLog: [],
    createdAt: at,
    updatedAt: at,
  }
}

/**
 * Writes one outbox row per (item event, matching enabled subscription).
 * Must run inside the transaction of the write that produced `events`.
 * Returns the number of rows written.
 */
export async function enqueueWebhookDeliveries(
  ctx: ServiceContext,
  repos: Repositories,
  events: readonly DomainEventInput[]
): Promise<number> {
  const itemEvents = events.filter(isItemEvent)
  if (itemEvents.length === 0) return 0
  const webhooks = (await repos.webhooks.list()).filter((w) => w.enabled)
  if (webhooks.length === 0) return 0

  const parents = new Map<string, string | null>()
  const tubeFolders = new Map<string, string[]>()
  const tubeFolderPath = async (tubeId: string) => {
    let path = tubeFolders.get(tubeId)
    if (!path) {
      const tube = await repos.tubes.get(tubeId)
      path = tube ? await folderPath(repos, tube.folderId, parents) : []
      tubeFolders.set(tubeId, path)
    }
    return path
  }

  let written = 0
  for (const event of itemEvents) {
    const path = await tubeFolderPath(event.tubeId)
    const targets = webhooks.filter((w) => webhookMatches(w, event, path))
    if (targets.length === 0) continue
    // Item state as committed by this transaction (no payload in the event).
    const item = await repos.items.get(event.itemId)
    const payload: WebhookPayload = {
      id: ctx.newId(),
      type: event.type,
      createdAt: event.at,
      data: {
        action: event.action,
        actor: event.actor,
        itemId: event.itemId,
        tubeId: event.tubeId,
        folderId: path[0] ?? null,
        status: event.status,
        ...(event.previousStatus && { previousStatus: event.previousStatus }),
        assignedAgent: event.assignedAgent,
        item,
      },
    }
    const at = ctx.clock.now().toISOString()
    for (const webhook of targets) {
      await repos.webhookDeliveries.create(
        newDelivery(ctx, webhook.id, payload, at)
      )
      written++
    }
  }
  return written
}

import type { ItemStatus } from "../domain/schemas"

/**
 * Domain events published by the application services after a successful
 * (committed) write. Client-safe: no Node imports, so the dashboard's
 * EventSource consumer can share these types.
 *
 * Events are notifications, not state: they carry ids and a few hot fields
 * (status, agent) but never payloads. Consumers refetch what they display.
 */

type EventBase = {
  /** Monotonic per-process sequence number, assigned by the bus (SSE `id:`). */
  seq: number
  /** ISO timestamp of the write. */
  at: string
  /** Who did it, `actorToString` format (e.g. `agent:bot-1`, `user:admin`). */
  actor: string
  /** Workspace of the write (multi-workspace mode); subscribers filter on it. */
  workspace?: string
}

export const ITEM_EVENT_TYPES = [
  "item.created",
  "item.updated",
  "item.status_changed",
  "item.deleted",
] as const
export type ItemEventType = (typeof ITEM_EVENT_TYPES)[number]

export type ItemEvent = EventBase & {
  type: ItemEventType
  /** The audit action behind it (claimed, completed, heartbeat, updated, …). */
  action: string
  itemId: string
  tubeId: string
  status: ItemStatus
  /** Set when the status changed (always on `item.status_changed`). */
  previousStatus?: ItemStatus
  assignedAgent: string | null
}

export type FolderEvent = EventBase & {
  type: "folder.created" | "folder.updated" | "folder.deleted"
  folderId: string
  parentId: string | null
}

export type TubeEvent = EventBase & {
  type: "tube.created" | "tube.updated" | "tube.deleted"
  tubeId: string
  /** `null` for top-level tubes. */
  folderId: string | null
}

export type DomainEvent = ItemEvent | FolderEvent | TubeEvent
export type DomainEventType = DomainEvent["type"]

/** An event as handed to the bus (the bus stamps `seq`). */
export type DomainEventInput = DomainEvent extends infer E
  ? E extends unknown
    ? Omit<E, "seq">
    : never
  : never

export const isItemEvent = (e: DomainEvent): e is ItemEvent =>
  e.type.startsWith("item.")

/** Folder / tube changes: they reshape the explorer tree. */
export const isStructuralEvent = (
  e: DomainEvent
): e is FolderEvent | TubeEvent => !isItemEvent(e)

/**
 * What a subscriber wants to hear about. Structural (folder / tube) events
 * are delivered to every scope — the explorer tree is on every dashboard
 * page; item events only to `global`, their tube's or their item's scope.
 */
export type EventScope =
  | { kind: "global" }
  | { kind: "tube"; tubeId: string }
  | { kind: "item"; itemId: string }

export function matchesEventScope(
  event: DomainEvent,
  scope: EventScope
): boolean {
  if (scope.kind === "global" || isStructuralEvent(event)) return true
  return scope.kind === "tube"
    ? event.tubeId === scope.tubeId
    : event.itemId === scope.itemId
}

const SCOPE_ID = /^[0-9a-f-]{36}$/i

/**
 * Scope from query params: `?itemId=<uuid>` → item, `?tubeId=<uuid>` → tube,
 * neither → global. Returns `null` for malformed ids.
 */
export function parseEventScope(params: URLSearchParams): EventScope | null {
  const itemId = params.get("itemId")
  const tubeId = params.get("tubeId")
  if (itemId !== null) {
    return SCOPE_ID.test(itemId) ? { kind: "item", itemId } : null
  }
  if (tubeId !== null) {
    return SCOPE_ID.test(tubeId) ? { kind: "tube", tubeId } : null
  }
  return { kind: "global" }
}

/** Query string for a scope (inverse of `parseEventScope`). */
export function eventScopeSearch(scope: EventScope): string {
  switch (scope.kind) {
    case "global":
      return ""
    case "tube":
      return `?tubeId=${encodeURIComponent(scope.tubeId)}`
    case "item":
      return `?itemId=${encodeURIComponent(scope.itemId)}`
  }
}

/** SSE `event:` name used for domain events (keep-alives are comments). */
export const SSE_DOMAIN_EVENT = "domain"
/** SSE `event:` sent once when a stream opens. */
export const SSE_READY_EVENT = "ready"
/** Dashboard event stream endpoint (session cookie auth). */
export const DASHBOARD_EVENTS_PATH = "/api/dashboard/events"

import type { ItemStatus } from "./schemas"

/**
 * Item status lifecycle (plan §4). One table shared by manual updates
 * (PATCH / MCP `update_item` / dashboard), claim processing (05) and the
 * retry sweeper (15), so every transport enforces the same rules.
 *
 *   pending ──claim──▶ processing ──▶ completed | failed | retry | cancelled
 *      ▲                    │ release / lease expiry
 *      └────────────────────┘
 *   failed / retry / cancelled ──▶ pending (requeue);  terminal ──▶ archived
 */
export const ITEM_STATUS_TRANSITIONS: Readonly<
  Record<ItemStatus, readonly ItemStatus[]>
> = {
  pending: ["processing", "cancelled", "archived"],
  processing: ["completed", "failed", "retry", "cancelled", "pending"],
  retry: ["processing", "pending", "cancelled", "archived"],
  failed: ["retry", "pending", "cancelled", "archived"],
  completed: ["archived"],
  cancelled: ["pending", "archived"],
  archived: [],
}

/**
 * Statuses that can only be entered through the processing API (claim), not
 * set directly by a manual update: `processing` needs an agent and a lease.
 */
export const CLAIM_ONLY_STATUSES: readonly ItemStatus[] = ["processing"]

export function canTransition(from: ItemStatus, to: ItemStatus): boolean {
  return from === to || ITEM_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * Whether a manual update (operator: PATCH / MCP `update_item` / dashboard,
 * not claim/complete/fail) may move `from` → `to`. Any status may be set
 * from any status, except `processing` (only a claim starts processing):
 *
 * - `pending`: lease, `assignedAgent` and `retryAt` are cleared; `createdAt`
 *   is kept, so the item keeps its place in the queue.
 * - `completed` / `failed` / `cancelled` / `archived`: the lease is cleared;
 *   `assignedAgent` is kept for history.
 *
 * Either way the former lease holder can no longer complete / fail /
 * release / heartbeat the item (409 conflict).
 */
export function canTransitionManually(
  from: ItemStatus,
  to: ItemStatus
): boolean {
  return !CLAIM_ONLY_STATUSES.includes(to)
}

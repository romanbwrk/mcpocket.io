import { systemActor, type Actor } from "../domain/actor"
import {
  decideRetry,
  resolveRetryPolicy,
  type ResolvedRetryPolicy,
} from "../domain/retry-policy"
import type { Item, ItemError, Tube } from "../domain/schemas"
import type { Repositories } from "../storage"

import type { ServiceContext } from "./context"
import { emit, itemEvent, transact } from "./events"
import { recordHistory } from "./history"

/** Actor recorded in history for lease-expiry recoveries. */
export const LEASE_SWEEPER_ACTOR: Actor = systemActor("lease-sweeper")

/**
 * Whether a `processing` item's lease has run out. A processing item without
 * `leaseExpiresAt` holds a lease that never expires (`leaseSeconds: 0`).
 */
export function isLeaseExpired(item: Item, now: Date): boolean {
  return (
    item.status === "processing" &&
    !!item.leaseExpiresAt &&
    Date.parse(item.leaseExpiresAt) <= now.getTime()
  )
}

/** `retry` items wait until `retryAt` (backoff); other statuses are never delayed. */
export function isRetryDue(item: Item, now: Date): boolean {
  return (
    item.status !== "retry" ||
    !item.retryAt ||
    Date.parse(item.retryAt) <= now.getTime()
  )
}

/** Effective policy of a tube: its overrides over the context defaults. */
export function tubeRetryPolicy(
  ctx: ServiceContext,
  tube: Pick<Tube, "retryPolicy"> | null | undefined
): ResolvedRetryPolicy {
  return resolveRetryPolicy(tube?.retryPolicy, ctx.retryDefaults)
}

export type ExpiredLease = { before: Item; after: Item }

/**
 * Recovers every `processing` item whose lease has expired (optionally in one
 * tube): attempts remaining → `retry` (claimable immediately — an expired
 * lease means the agent died, not that the item is bad), attempts exhausted →
 * `failed`. Stores `lastError` (code `lease_expired`), writes a
 * `lease_expired` history event and emits an item event, all within the
 * caller's transaction (`repos` must come from `transact`).
 */
export async function expireLeases(
  ctx: ServiceContext,
  repos: Repositories,
  now: Date,
  {
    tubeId,
    actor = LEASE_SWEEPER_ACTOR,
  }: { tubeId?: string; actor?: Actor } = {}
): Promise<ExpiredLease[]> {
  const expired = (
    await repos.items.list({
      ...(tubeId && { tubeId }),
      status: ["processing"],
    })
  ).filter((item) => isLeaseExpired(item, now))
  if (expired.length === 0) return []

  const ts = now.toISOString()
  const policies = new Map<string, ResolvedRetryPolicy>()
  const results: ExpiredLease[] = []
  for (const item of expired) {
    let policy = policies.get(item.tubeId)
    if (!policy) {
      policy = tubeRetryPolicy(ctx, await repos.tubes.get(item.tubeId))
      policies.set(item.tubeId, policy)
    }
    const decision = decideRetry(policy, item.attempts, now, {
      immediate: true,
    })
    const lastError: ItemError = {
      message: `Lease expired (attempt ${item.attempts} of ${decision.maxAttempts})`,
      code: "lease_expired",
      at: ts,
      attempt: item.attempts,
      ...(item.assignedAgent && { agentId: item.assignedAgent }),
    }
    const status = decision.retry ? "retry" : "failed"
    const after = await repos.items.update(item.id, {
      status,
      leaseExpiresAt: null,
      retryAt: decision.retry ? decision.retryAt : undefined,
      lastError,
      updatedAt: ts,
    })
    if (!after) continue
    await recordHistory(ctx, repos, actor, {
      itemId: item.id,
      action: "lease_expired",
      oldValue: {
        status: item.status,
        assignedAgent: item.assignedAgent ?? null,
        leaseExpiresAt: item.leaseExpiresAt ?? null,
        attempts: item.attempts,
      },
      newValue: {
        status,
        maxAttempts: decision.maxAttempts,
        ...(decision.retry && { retryAt: decision.retryAt }),
        error: lastError,
      },
      at: ts,
    })
    emit(ctx, itemEvent(actor, "lease_expired", item, after))
    results.push({ before: item, after })
  }
  return results
}

export type SweepResult = {
  /** Items moved to `retry`. */
  requeued: number
  /** Items moved to `failed` (attempts exhausted). */
  failed: number
  items: Item[]
}

/**
 * One sweeper pass: `expireLeases` across all tubes in one write transaction
 * (v1: the write mutex), so it never races a concurrent claim. Events are
 * published after commit.
 */
export async function sweepExpiredLeases(
  ctx: ServiceContext,
  options: { tubeId?: string; actor?: Actor } = {}
): Promise<SweepResult> {
  // Cheap read first: skip the write lock + persist when nothing expired.
  const now = ctx.clock.now()
  const processing = await ctx.storage.items.list({
    ...(options.tubeId && { tubeId: options.tubeId }),
    status: ["processing"],
  })
  if (!processing.some((item) => isLeaseExpired(item, now))) {
    return { requeued: 0, failed: 0, items: [] }
  }
  const expired = await transact(ctx, (repos) =>
    expireLeases(ctx, repos, ctx.clock.now(), options)
  )
  const items = expired.map((e) => e.after)
  return {
    requeued: items.filter((i) => i.status === "retry").length,
    failed: items.filter((i) => i.status === "failed").length,
    items,
  }
}

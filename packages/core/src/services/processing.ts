import { z } from "zod"

import type { Actor } from "../domain/actor"
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../domain/errors"
import { StatusFilterSchema } from "../domain/item-filter"
import { canTransition } from "../domain/item-status"
import { decideRetry, type RetryDecision } from "../domain/retry-policy"
import {
  descWindow,
  PageInputSchema,
  pageOf,
  SortOrderSchema,
  type PageResult,
} from "../domain/pagination"
import {
  IdSchema,
  LeaseSecondsSchema,
  type Item,
  type ItemError,
  type Tube,
  type ItemStatus,
} from "../domain/schemas"
import type { Patch, Repositories } from "../storage"

import { buildScopeView, createAccessControl } from "./access"
import type { ServiceContext } from "./context"
import { emit, itemEvent, transact } from "./events"
import { recordHistory } from "./history"
import { PushItemInputSchema, pushItemInTransaction, withMedia } from "./items"
import { mediaMaterializer } from "./media"
import {
  expireLeases,
  isLeaseExpired,
  isRetryDue,
  tubeRetryPolicy,
} from "./retry"

export const ClaimItemInputSchema = z.strictObject({
  /** Tube to claim from. */
  tubeId: IdSchema,
  /** Lease duration override; defaults to the server's `MCPOCKET_LEASE_SECONDS`. */
  leaseSeconds: LeaseSecondsSchema.optional(),
})
export type ClaimItemInput = z.input<typeof ClaimItemInputSchema>

/** Max follow-up items per `complete`. */
export const MAX_NEXT_ITEMS = 100

/**
 * A follow-up item created by `complete`: a push (same fields and rules as
 * `push_item`) into `tubeId`, e.g. prompt → image → video pipelines.
 */
export const NextItemInputSchema = PushItemInputSchema.extend({
  tubeId: IdSchema,
})
export type NextItemInput = z.input<typeof NextItemInputSchema>

export const CompleteItemInputSchema = z.strictObject({
  /**
   * Any JSON value; stored as `item.result`. Media data URIs inside it are
   * uploaded and replaced by their URL (when media storage is configured).
   */
  result: z.unknown().optional(),
  /**
   * Item(s) to push into other tubes in the same atomic write. Each gets
   * `metadata.source = { tubeId, itemId }` of the completed item.
   */
  next: z
    .union([
      NextItemInputSchema,
      z
        .array(NextItemInputSchema)
        .min(1)
        .max(MAX_NEXT_ITEMS, `At most ${MAX_NEXT_ITEMS} next items`),
    ])
    .optional(),
})
export type CompleteItemInput = z.input<typeof CompleteItemInputSchema>

const ErrorInfoSchema = z.strictObject({
  message: z.string().trim().min(1).max(10_000),
  code: z.string().trim().min(1).max(200).optional(),
  details: z.unknown().optional(),
})

export const FailItemInputSchema = z.strictObject({
  /** A message, or `{ message, code?, details? }`; stored as `item.lastError`. */
  error: z.union([
    z
      .string()
      .trim()
      .min(1)
      .max(10_000)
      .transform((message) => ({ message })),
    ErrorInfoSchema,
  ]),
})
export type FailItemInput = z.input<typeof FailItemInputSchema>

export const ReleaseItemInputSchema = z.strictObject({
  reason: z.string().trim().max(2000).optional(),
})
export type ReleaseItemInput = z.input<typeof ReleaseItemInputSchema>

export const HeartbeatItemInputSchema = z.strictObject({
  leaseSeconds: LeaseSecondsSchema.optional(),
})
export type HeartbeatItemInput = z.input<typeof HeartbeatItemInputSchema>

export const AgentItemsInputSchema = PageInputSchema.extend({
  /** One status, an array or a comma list. Default: all statuses. */
  status: StatusFilterSchema.optional(),
  /** `asc` (oldest first, default) or `desc` (newest first) by `createdAt`. */
  order: SortOrderSchema,
})
export type AgentItemsInput = z.input<typeof AgentItemsInputSchema>

export const AgentIdSchema = z.string().regex(/^[A-Za-z0-9._:@-]{1,128}$/)

/** What a successful claim hands to the agent (plan §9). */
export type Claim = {
  itemId: string
  agentId: string
  claimedAt: string
  leaseExpiresAt: string
  attempts: number
}

export type ClaimResult = { item: Item; claim: Claim }

/** `complete` outcome: the completed item and the follow-up items it pushed. */
export type CompleteResult = { item: Item; next: Item[] }

/** Statuses a claim picks up (plus `processing` with an expired lease). */
export const CLAIMABLE_STATUSES: readonly ItemStatus[] = ["pending", "retry"]

/** Claim order: highest priority first, then oldest (`createdAt`, then id). */
export function compareClaimOrder(a: Item, b: Item): number {
  return (
    b.priority - a.priority ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  )
}

export type ProcessingService = ReturnType<typeof createProcessingService>

/**
 * Agent work loop: claim → heartbeat* → complete | fail | release.
 *
 * The agent is the authenticated actor (`kind: "agent"`, REST `X-Agent-Id`,
 * MCP session) — never a request argument, so it cannot be spoofed. Every
 * operation runs in one `storage.transaction` (v1: the write mutex), which
 * makes claim atomic: concurrent claimers never get the same item.
 */
export function createProcessingService(ctx: ServiceContext, actor: Actor) {
  const { storage } = ctx
  const ac = createAccessControl(ctx, actor)

  function requireAgent(): string {
    if (actor.kind !== "agent") {
      throw new ValidationError(
        "An agent identity is required (send the X-Agent-Id header)"
      )
    }
    return actor.id
  }

  /** Explicit seconds → the tube's default → the server default. */
  const leaseUntil = (now: Date, seconds?: number, tube?: Tube | null) =>
    new Date(
      now.getTime() + (seconds ?? tube?.leaseSeconds ?? ctx.leaseSeconds) * 1000
    ).toISOString()

  /**
   * Loads an item and checks the caller holds its live lease:
   * deleted / not processing / expired → 409, other agent's lease → 403.
   */
  async function requireLease(
    repos: Repositories,
    id: string,
    agentId: string,
    now: Date
  ): Promise<Item> {
    IdSchema.parse(id)
    const item = await repos.items.get(id)
    if (!item) throw new NotFoundError("Item", id)
    const scope = await ac.view(repos)
    if (!scope.unrestricted) {
      ac.assertItem(scope, item, await repos.tubes.get(item.tubeId))
    }
    if (item.deletedAt) {
      throw new ConflictError(`Item "${id}" is deleted`, {
        deletedAt: item.deletedAt,
      })
    }
    if (item.status !== "processing") {
      throw new ConflictError(`Item "${id}" is not being processed`, {
        status: item.status,
      })
    }
    if (item.assignedAgent !== agentId) {
      throw new ForbiddenError(`Item "${id}" is leased by another agent`)
    }
    if (isLeaseExpired(item, now)) {
      throw new ConflictError(`Lease on item "${id}" has expired`, {
        leaseExpiresAt: item.leaseExpiresAt ?? null,
      })
    }
    return item
  }

  /**
   * Ends a lease with a status change, writing one history event. `build`
   * may pick the target status (`to`), e.g. `fail` → `retry` | `failed`.
   */
  async function finish(
    id: string,
    defaultTo: ItemStatus,
    action: "completed" | "failed" | "released",
    build: (
      item: Item,
      ts: string,
      repos: Repositories,
      now: Date
    ) => Promise<{
      to?: ItemStatus
      patch: Patch<Item>
      newValue?: Record<string, unknown>
    }>
  ): Promise<Item> {
    ac.require("items:process")
    const agentId = requireAgent()
    return transact(ctx, async (repos) => {
      const now = ctx.clock.now()
      const ts = now.toISOString()
      const item = await requireLease(repos, id, agentId, now)
      const {
        to = defaultTo,
        patch,
        newValue,
      } = await build(item, ts, repos, now)
      if (!canTransition(item.status, to)) {
        throw new ConflictError(
          `Invalid status transition ${item.status} → ${to}`,
          { from: item.status, to }
        )
      }
      const updated = await repos.items.update(id, {
        retryAt: undefined,
        ...patch,
        status: to,
        leaseExpiresAt: null,
        updatedAt: ts,
      })
      if (!updated) throw new NotFoundError("Item", id)
      await recordHistory(ctx, repos, actor, {
        itemId: id,
        action,
        oldValue: {
          status: item.status,
          assignedAgent: item.assignedAgent,
          leaseExpiresAt: item.leaseExpiresAt,
        },
        newValue: { status: to, ...newValue },
        at: ts,
      })
      emit(ctx, itemEvent(actor, action, item, updated))
      return updated
    })
  }

  /**
   * A pipeline hand-off the caller may make although the target tube is
   * outside its scope: the target is one of the source tube's CURRENT
   * `nextTubeIds` AND the API key behind the connection reaches it
   * (`access.handoffAccess`, kept when a tube-scoped MCP connection binds).
   */
  async function isHandoffTarget(
    repos: Repositories,
    source: Tube | null,
    target: Tube
  ): Promise<boolean> {
    const base = ac.access.handoffAccess
    if (!base || !source?.nextTubeIds?.includes(target.id)) return false
    const [folders, tubes] = await Promise.all([
      repos.folders.list(),
      repos.tubes.list(),
    ])
    return buildScopeView(base, folders, tubes).canAccessTube(target)
  }

  const service = {
    /**
     * Claims the next item of a tube for the calling agent: the
     * highest-priority, oldest `pending` item or `retry` item whose backoff
     * (`retryAt`) has passed. Expired leases in the tube are recovered first
     * (same transaction, same rules as the sweeper), so a dead agent's item
     * is claimable right away while its attempts last. Sets `processing`,
     * `assignedAgent`, `leaseExpiresAt` and increments `attempts`. Returns
     * `null` when there is nothing to claim.
     */
    async claim(input: unknown): Promise<ClaimResult | null> {
      ac.require("items:process")
      const agentId = requireAgent()
      const { tubeId, leaseSeconds } = ClaimItemInputSchema.parse(input)
      return transact(ctx, async (repos) => {
        const tube = await repos.tubes.get(tubeId)
        if (!tube) throw new NotFoundError("Tube", tubeId)
        ac.assertTube(await ac.view(repos), tube)
        if (!tube.enabled) {
          throw new ConflictError(`Tube "${tubeId}" is disabled`, { tubeId })
        }
        const now = ctx.clock.now()
        await expireLeases(ctx, repos, now, { tubeId })
        const candidates = (
          await repos.items.list({ tubeId, status: [...CLAIMABLE_STATUSES] })
        ).filter((i) => isRetryDue(i, now))
        if (candidates.length === 0) return null
        const item = candidates.reduce((best, i) =>
          compareClaimOrder(i, best) < 0 ? i : best
        )

        const claimedAt = now.toISOString()
        const leaseExpiresAt = leaseUntil(now, leaseSeconds, tube)
        const attempts = item.attempts + 1
        const updated = await repos.items.update(item.id, {
          status: "processing",
          assignedAgent: agentId,
          leaseExpiresAt,
          attempts,
          retryAt: undefined,
          updatedAt: claimedAt,
        })
        if (!updated) throw new NotFoundError("Item", item.id)
        await recordHistory(ctx, repos, actor, {
          itemId: item.id,
          action: "claimed",
          oldValue: {
            status: item.status,
            assignedAgent: item.assignedAgent ?? null,
            leaseExpiresAt: item.leaseExpiresAt ?? null,
            attempts: item.attempts,
          },
          newValue: {
            status: "processing",
            assignedAgent: agentId,
            leaseExpiresAt,
            attempts,
          },
          at: claimedAt,
        })
        emit(ctx, itemEvent(actor, "claimed", item, updated))
        return {
          item: updated,
          claim: {
            itemId: item.id,
            agentId,
            claimedAt,
            leaseExpiresAt,
            attempts,
          },
        }
      })
    },

    /** Lease owner only. Sets `completed`, stores `result` and `completedAt`. */
    async complete(id: string, input: unknown = {}): Promise<Item> {
      return (await service.completeWithNext(id, input)).item
    },

    /**
     * `complete` that also pushes `next` items into other tubes — all in ONE
     * transaction: if any follow-up is rejected (missing / disabled /
     * out-of-scope tube, schema mismatch) nothing is written and the lease
     * stays. Needs `items:push` too when `next` is set. Media data URIs in
     * `result` and in `next` payload / metadata are uploaded first (once
     * per distinct file) and replaced by their URL.
     */
    async completeWithNext(
      id: string,
      input: unknown = {}
    ): Promise<CompleteResult> {
      const parsed = CompleteItemInputSchema.parse(input)
      let result = parsed.result
      let next =
        parsed.next === undefined
          ? []
          : Array.isArray(parsed.next)
            ? parsed.next
            : [parsed.next]
      ac.require("items:process")
      if (next.length > 0) ac.require("items:push")
      const agentId = requireAgent()

      if (ctx.media && (result !== undefined || next.length > 0)) {
        // Fail fast before uploading; the transaction checks the lease again.
        await requireLease(storage, id, agentId, ctx.clock.now())
        const materialize = mediaMaterializer(ctx)
        if (result !== undefined) result = await materialize(result, "result")
        const uploaded: typeof next = []
        for (const [i, entry] of next.entries()) {
          uploaded.push(await withMedia(materialize, entry, `next[${i}].`))
        }
        next = uploaded
      }

      const created: Item[] = []
      const item = await finish(
        id,
        "completed",
        "completed",
        async (source, ts, repos) => {
          const scope = next.length > 0 ? await ac.view(repos) : undefined
          const sourceTube =
            next.length > 0 ? await repos.tubes.get(source.tubeId) : null
          const lineage = sourceLineage(source)
          for (const [i, { tubeId, ...push }] of next.entries()) {
            try {
              const tube = await repos.tubes.get(tubeId)
              if (!tube) throw new NotFoundError("Tube", tubeId)
              if (
                !scope!.canAccessTube(tube) &&
                !(await isHandoffTarget(repos, sourceTube, tube))
              ) {
                ac.assertTube(scope!, tube)
              }
              const { item: pushed } = await pushItemInTransaction(
                ctx,
                actor,
                repos,
                tube,
                {
                  ...push,
                  metadata: { ...push.metadata, source: lineage },
                }
              )
              created.push(pushed)
            } catch (error) {
              if (!(error instanceof AppError)) throw error
              throw new AppError(
                error.code,
                `next[${i}]: ${error.message}`,
                error.details
              )
            }
          }
          return {
            patch: {
              ...(result !== undefined && { result }),
              completedAt: ts,
            },
            newValue: {
              completedAt: ts,
              ...(result !== undefined && { result }),
              ...(created.length > 0 && {
                next: created.map((c) => ({ tubeId: c.tubeId, itemId: c.id })),
              }),
            },
          }
        }
      )
      return { item, next: created }
    },

    /**
     * Lease owner only. Stores the error as `lastError`; then, per the tube's
     * retry policy, attempts remaining → `retry` with a backoff `retryAt`
     * (not claimable before), attempts exhausted → `failed`.
     */
    async fail(id: string, input: unknown): Promise<Item> {
      const { error } = FailItemInputSchema.parse(input)
      return finish(id, "failed", "failed", async (item, ts, repos, now) => {
        const lastError: ItemError = {
          ...error,
          at: ts,
          attempt: item.attempts,
          agentId: item.assignedAgent ?? undefined,
        }
        const policy = tubeRetryPolicy(ctx, await repos.tubes.get(item.tubeId))
        const decision: RetryDecision = decideRetry(policy, item.attempts, now)
        return decision.retry
          ? {
              to: "retry",
              patch: { lastError, retryAt: decision.retryAt },
              newValue: {
                error: lastError,
                retryAt: decision.retryAt,
                maxAttempts: decision.maxAttempts,
              },
            }
          : {
              to: "failed",
              patch: { lastError },
              newValue: { error: lastError, maxAttempts: decision.maxAttempts },
            }
      })
    },

    /** Lease owner only. Returns the item to `pending` and clears the lease. */
    async release(id: string, input: unknown = {}): Promise<Item> {
      const { reason } = ReleaseItemInputSchema.parse(input)
      return finish(id, "pending", "released", async () => ({
        patch: { assignedAgent: null },
        newValue: {
          assignedAgent: null,
          ...(reason !== undefined && { reason }),
        },
      }))
    },

    /** Lease owner only. Extends the lease to now + lease duration. */
    async heartbeat(id: string, input: unknown = {}): Promise<Item> {
      ac.require("items:process")
      const agentId = requireAgent()
      const { leaseSeconds } = HeartbeatItemInputSchema.parse(input)
      return transact(ctx, async (repos) => {
        const now = ctx.clock.now()
        const ts = now.toISOString()
        const item = await requireLease(repos, id, agentId, now)
        const leaseExpiresAt = leaseUntil(
          now,
          leaseSeconds,
          leaseSeconds === undefined ? await repos.tubes.get(item.tubeId) : null
        )
        const updated = await repos.items.update(id, {
          leaseExpiresAt,
          updatedAt: ts,
        })
        if (!updated) throw new NotFoundError("Item", id)
        await recordHistory(ctx, repos, actor, {
          itemId: id,
          action: "heartbeat",
          oldValue: { leaseExpiresAt: item.leaseExpiresAt },
          newValue: { leaseExpiresAt },
          at: ts,
        })
        emit(ctx, itemEvent(actor, "heartbeat", item, updated))
        return updated
      })
    },

    /**
     * Items assigned to an agent (live leases and items it completed /
     * failed), `createdAt` ascending (or `order: "desc"`). Any authenticated caller may read.
     */
    async agentItems(
      agentId: string,
      input: unknown = {}
    ): Promise<PageResult<Item>> {
      AgentIdSchema.parse(agentId)
      const { offset, limit, status, order } =
        AgentItemsInputSchema.parse(input)
      ac.require("read")
      const query = {
        assignedAgent: agentId,
        ...(status && status.length > 0 && { status }),
      }
      const scope = await ac.view()
      if (!scope.unrestricted) {
        const tubes = new Map(
          (await storage.tubes.list()).map((t) => [t.id, t])
        )
        const visible = (await storage.items.list(query)).filter((item) => {
          const tube = tubes.get(item.tubeId)
          return tube !== undefined && scope.canAccessTube(tube)
        })
        return {
          data: pageOf(visible, { offset, limit, order }),
          page: { offset, limit, total: visible.length },
        }
      }
      if (order === "desc") {
        const total = await storage.items.count(query)
        const window = descWindow(total, offset, limit)
        const data =
          window.limit > 0
            ? (await storage.items.list({ ...query, ...window })).reverse()
            : []
        return { data, page: { offset, limit, total } }
      }
      const [data, total] = await Promise.all([
        storage.items.list({ ...query, offset, limit }),
        storage.items.count(query),
      ])
      return { data, page: { offset, limit, total } }
    },

    /**
     * `agentItems` for the calling agent itself (MCP `get_my_items`): the
     * agent id comes from the authenticated actor, never from the input.
     */
    async myItems(input: unknown = {}): Promise<PageResult<Item>> {
      return service.agentItems(requireAgent(), input)
    },
  }
  return service
}

/**
 * `metadata.source` of an item created by `complete { next }`: the
 * completed item plus the first item of the chain (`root`), so any stage
 * can reach the original input (e.g. the prompt) with one `get_item`.
 */
export function sourceLineage(item: Item): ItemSource {
  const parent = (item.metadata as { source?: Partial<ItemSource> } | undefined)
    ?.source
  const root =
    parent?.root ??
    (parent?.tubeId && parent.itemId
      ? { tubeId: parent.tubeId, itemId: parent.itemId }
      : { tubeId: item.tubeId, itemId: item.id })
  return { tubeId: item.tubeId, itemId: item.id, root }
}

export type ItemSource = {
  tubeId: string
  itemId: string
  root: { tubeId: string; itemId: string }
}

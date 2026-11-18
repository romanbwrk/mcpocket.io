import { isDeepStrictEqual } from "node:util"

import { z } from "zod"

import type { Actor } from "../domain/actor"
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors"
import {
  hasItemFilter,
  ItemFilterSchema,
  matchesItemFilter,
  StatusFilterSchema,
} from "../domain/item-filter"
import { canTransitionManually } from "../domain/item-status"
import { validateJsonSchema } from "../domain/json-schema"
import {
  descWindow,
  PageInputSchema,
  pageOf,
  SortOrderSchema,
  type PageResult,
} from "../domain/pagination"
import {
  IdSchema,
  ItemSchema,
  ItemStatusSchema,
  JsonObjectSchema,
  type HistoryEvent,
  type Item,
  type Tube,
} from "../domain/schemas"
import type { Patch, Repositories } from "../storage"

import { createAccessControl, type ScopeView } from "./access"
import type { ServiceContext } from "./context"
import { isExpectedError, normalizeError, type ErrorInfo } from "./errors"
import { emit, itemEvent, transact } from "./events"
import { recordHistory } from "./history"
import { mediaMaterializer } from "./media"

const TagsSchema = z
  .array(z.string().trim().min(1).max(100))
  .max(100)
  .transform((tags) => [...new Set(tags)])
const PrioritySchema = ItemSchema.shape.priority

export const PushItemInputSchema = z.strictObject({
  /** The JSON object to store; validated against the tube's `schemaDefinition`. */
  payload: JsonObjectSchema,
  /** Higher is claimed first. Default 0. */
  priority: PrioritySchema.default(0),
  tags: TagsSchema.default([]),
  metadata: JsonObjectSchema.default({}),
  /** Per-tube dedupe key: repeating a push with it returns the original item. */
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
})
export type PushItemInput = z.input<typeof PushItemInputSchema>

/** Fields a manual update may change. `metadata` and `tags` are replaced, not merged. */
export const UpdateItemInputSchema = z
  .strictObject({
    payload: JsonObjectSchema.optional(),
    metadata: JsonObjectSchema.optional(),
    tags: TagsSchema.optional(),
    priority: PrioritySchema.optional(),
    /**
     * Any status but `processing` (see `canTransitionManually` in
     * `domain/item-status.ts` for the side effects on lease and agent).
     */
    status: ItemStatusSchema.optional(),
    /**
     * Any JSON value, stored as `item.result`; `null` clears it. No lease
     * needed. Media data URIs inside it are uploaded and replaced by their URL.
     */
    result: z.unknown().optional(),
  })
  .refine((input) => Object.values(input).some((v) => v !== undefined), {
    message:
      "At least one of payload, metadata, tags, priority, status, result is required",
  })
export type UpdateItemInput = z.input<typeof UpdateItemInputSchema>

const BooleanQuerySchema = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1")

/**
 * Pagination + filters (see `lib/domain/item-filter.ts`): status, assignedAgent,
 * createdFrom/createdTo, priority/priorityMin/priorityMax, tags (all of),
 * payload conditions. Filters are evaluated in memory, then paginated.
 */
export const ListItemsInputSchema = PageInputSchema.extend({
  /** Include soft-deleted items. Default false. */
  includeDeleted: BooleanQuerySchema.default(false),
  /** `asc` (oldest first, default) or `desc` (newest first) by `createdAt`. */
  order: SortOrderSchema,
  ...ItemFilterSchema.shape,
})
export type ListItemsInput = z.input<typeof ListItemsInputSchema>

/** `ListItemsInputSchema` plus an optional `tubeId` (omit to search every tube). */
export const SearchItemsInputSchema = ListItemsInputSchema.extend({
  tubeId: IdSchema.optional(),
})
export type SearchItemsInput = z.input<typeof SearchItemsInputSchema>

/** Max entries per bulk request (push or update). */
export const MAX_BULK_ITEMS = 500
/** Max REST request body size of a bulk request. */
export const MAX_BULK_BODY_BYTES = 5 * 1024 * 1024

const BulkEntriesSchema = z
  .array(z.unknown())
  .min(1)
  .max(MAX_BULK_ITEMS, `At most ${MAX_BULK_ITEMS} entries per bulk request`)

/** `{ items: PushItemInput[] }` — each entry validated like a single push. */
export const BulkPushItemsInputSchema = z.strictObject({
  items: BulkEntriesSchema,
})
export type BulkPushItemsInput = { items: PushItemInput[] }

const BulkUpdateEntrySchema = z.looseObject({ id: IdSchema })

/**
 * Item filters of a server-side bulk operation (status, assignedAgent,
 * created range, priority, tags, payload conditions; see
 * `domain/item-filter.ts`). Empty = every non-deleted item of the tube.
 */
export const BulkItemFilterSchema = z.strictObject(ItemFilterSchema.shape)

/**
 * One of:
 * - per-item changes `{ items: [{ id, ...UpdateItemInput }] }`,
 * - one change for many items `{ ids: [...], patch: UpdateItemInput }`,
 * - one change for every item of a tube matching a filter
 *   `{ tubeId, filter: { status: "processing" }, patch }` (server-side, no cap).
 */
export const BulkUpdateItemsInputSchema = z
  .strictObject({
    items: BulkEntriesSchema.optional(),
    ids: z
      .array(IdSchema)
      .min(1)
      .max(MAX_BULK_ITEMS, `At most ${MAX_BULK_ITEMS} entries per bulk request`)
      .optional(),
    tubeId: IdSchema.optional(),
    filter: BulkItemFilterSchema.optional(),
    patch: UpdateItemInputSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const byFilter = v.tubeId !== undefined || v.filter !== undefined
    const forms = [v.items !== undefined, v.ids !== undefined, byFilter]
    const issue = (message: string) => ctx.addIssue({ code: "custom", message })
    if (forms.filter(Boolean).length !== 1) {
      issue(
        "Send exactly one of `items`, `ids` + `patch`, or `tubeId` + `filter` + `patch`"
      )
    } else if (v.items !== undefined && v.patch !== undefined) {
      issue("`patch` cannot be combined with `items`")
    } else if (v.items === undefined && v.patch === undefined) {
      issue("`patch` is required with `ids` / `tubeId` + `filter`")
    } else if (byFilter && (v.tubeId === undefined || v.filter === undefined)) {
      issue("`tubeId` and `filter` must be sent together")
    }
  })
export type BulkUpdateItemsInput =
  | { items: Array<{ id: string } & UpdateItemInput> }
  | { ids: string[]; patch: UpdateItemInput }
  | {
      tubeId: string
      filter: z.input<typeof BulkItemFilterSchema>
      patch: UpdateItemInput
    }

/** Outcome of `bulk_update_items` in its filter form: items actually changed. */
export type BulkUpdateByFilterResult = { affected: number }

/** Max ids per `bulkDelete` in its ids form. */
export const MAX_BULK_DELETE_IDS = 1000

/**
 * Either `{ ids: [...] }` (≤ `MAX_BULK_DELETE_IDS`, per-item results) or
 * `{ tubeId, status? }`: every non-deleted item of the tube (optionally only
 * these statuses: one, an array or a comma list), server-side, no cap.
 */
export const BulkDeleteItemsInputSchema = z
  .strictObject({
    ids: z
      .array(IdSchema)
      .min(1)
      .max(
        MAX_BULK_DELETE_IDS,
        `At most ${MAX_BULK_DELETE_IDS} ids per bulk delete`
      )
      .optional(),
    tubeId: IdSchema.optional(),
    status: StatusFilterSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.ids === undefined) === (v.tubeId === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Send either `ids` or `tubeId` (+ optional `status`)",
      })
    } else if (v.ids !== undefined && v.status !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "`status` filters only the `tubeId` form",
      })
    }
  })
export type BulkDeleteItemsInput = z.input<typeof BulkDeleteItemsInputSchema>

/** Items soft-deleted; the ids form also returns per-item `results`. */
export type BulkDeleteResult = {
  deleted: number
  results?: BulkItemResult[]
}

/** Outcome of one bulk entry; `index` is its position in the request. */
export type BulkItemResult =
  | { index: number; ok: true; created?: boolean; data: Item }
  | { index: number; ok: false; id?: string; error: ErrorInfo }

export type BulkResult = {
  results: BulkItemResult[]
  summary: {
    total: number
    succeeded: number
    failed: number
    /** Bulk push only: new items (succeeded − created = idempotent replays). */
    created?: number
  }
}

function summarize(
  results: BulkItemResult[],
  withCreated: boolean
): BulkResult {
  const succeeded = results.filter((r) => r.ok).length
  return {
    results,
    summary: {
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      ...(withCreated && {
        created: results.filter((r) => r.ok && r.created).length,
      }),
    },
  }
}

/**
 * `{ agentId }` — new `assignedAgent`; `null` unassigns. On a `processing`
 * item the lease (expiry unchanged) moves to the new agent, who may then
 * complete / fail / release it; unassigning a processing item is rejected
 * (use release or a status change instead).
 */
export const ReassignItemInputSchema = z.strictObject({
  agentId: z.string().trim().min(1).max(200).nullable(),
})
export type ReassignItemInput = z.input<typeof ReassignItemInputSchema>

export const ItemHistoryInputSchema = PageInputSchema
export type ItemHistoryInput = z.input<typeof ItemHistoryInputSchema>

export type PushItemResult = {
  item: Item
  /** false when an existing item was returned for a repeated idempotency key. */
  created: boolean
}

/**
 * Which items a tube reset (`requeueAll`) touches: the item filters of
 * `ListItemsInputSchema` (status, assignedAgent, created range, priority,
 * tags, payload conditions). Empty = every non-deleted item.
 * E.g. `{ status: "failed" }` or `{ status: ["failed", "cancelled"] }`.
 */
export const RequeueAllInputSchema = z.strictObject(ItemFilterSchema.shape)
export type RequeueAllInput = z.input<typeof RequeueAllInputSchema>

/** Outcome of a tube reset (`requeueAll`). */
export type RequeueAllResult = {
  /** Non-deleted items in the tube. */
  total: number
  /** Items matching the reset filter (= `total` without a filter). */
  matched: number
  /** Matched items that were changed (the rest were already fresh `pending`). */
  requeued: number
}

/** A `pending` item nobody has touched yet: nothing for a reset to clear. */
function isFresh(item: Item): boolean {
  return (
    item.status === "pending" &&
    !item.assignedAgent &&
    !item.leaseExpiresAt &&
    item.attempts === 0 &&
    !item.retryAt &&
    item.result === undefined &&
    !item.lastError &&
    !item.completedAt
  )
}

const EDITABLE_FIELDS = ["payload", "metadata", "tags", "priority"] as const

type JsonObject = Record<string, unknown>
type MediaFields = {
  payload?: JsonObject
  metadata?: JsonObject
  result?: unknown
}

/**
 * Uploads media data URIs in `payload` / `metadata` to S3 and swaps them for
 * URLs (see `services/media.ts`). Runs BEFORE the storage transaction, so
 * uploads never hold the write lock.
 */
export async function withMedia<T extends MediaFields>(
  materialize: ReturnType<typeof mediaMaterializer>,
  input: T,
  /** Error path prefix, e.g. `next[0].` */
  prefix = ""
): Promise<T> {
  const out = { ...input }
  if (input.payload !== undefined) {
    out.payload = await materialize(input.payload, `${prefix}payload`)
  }
  if (input.metadata !== undefined) {
    out.metadata = await materialize(input.metadata, `${prefix}metadata`)
  }
  if (input.result !== undefined && input.result !== null) {
    out.result = await materialize(input.result, `${prefix}result`)
  }
  return out
}

/** Bulk entry prepared outside the transaction: parsed input or its error. */
type Prepared<T> = { id?: string; input?: T; error?: unknown }

async function prepareEntry<T>(
  id: string | undefined,
  prepare: () => Promise<T>
): Promise<Prepared<T>> {
  try {
    return { ...(id !== undefined && { id }), input: await prepare() }
  } catch (error) {
    // Expected errors (validation, media too large) fail just this entry.
    if (!isExpectedError(error)) throw error
    return { ...(id !== undefined && { id }), error }
  }
}

function unwrap<T>(entry: unknown): T {
  const prepared = entry as Prepared<T>
  if (prepared.error !== undefined) throw prepared.error
  return prepared.input as T
}

function assertPayloadMatchesTube(tube: Tube, payload: unknown) {
  if (!tube.schemaDefinition) return
  const issues = validateJsonSchema(tube.schemaDefinition, payload)
  if (issues.length > 0) {
    throw new ValidationError(
      `Payload does not match the schema of tube "${tube.id}"`,
      issues.map((i) => ({ ...i, path: `payload${i.path}` }))
    )
  }
}

/**
 * Push of one validated entry inside the caller's transaction (tube already
 * loaded and scope-checked): idempotency key, disabled tube, tube schema,
 * `created` history event. Shared by push, bulk push and `complete { next }`.
 */
export async function pushItemInTransaction(
  ctx: ServiceContext,
  actor: Actor,
  repos: Repositories,
  tube: Tube,
  input: z.output<typeof PushItemInputSchema>
): Promise<PushItemResult> {
  const { payload, priority, tags, metadata, idempotencyKey } = input
  if (idempotencyKey !== undefined) {
    const existing = await repos.items.findByIdempotencyKey(
      tube.id,
      idempotencyKey
    )
    if (existing) return { item: existing, created: false }
  }
  if (!tube.enabled) {
    throw new ConflictError(`Tube "${tube.id}" is disabled`, {
      tubeId: tube.id,
    })
  }
  assertPayloadMatchesTube(tube, payload)
  const ts = ctx.clock.now().toISOString()
  const item = await repos.items.create({
    id: ctx.newId(),
    tubeId: tube.id,
    status: "pending",
    payload,
    metadata,
    tags,
    priority,
    assignedAgent: null,
    leaseExpiresAt: null,
    attempts: 0,
    ...(idempotencyKey !== undefined && { idempotencyKey }),
    createdAt: ts,
    updatedAt: ts,
  })
  await recordHistory(ctx, repos, actor, {
    itemId: item.id,
    action: "created",
    newValue: item,
    at: ts,
  })
  emit(ctx, itemEvent(actor, "created", null, item))
  return { item, created: true }
}

export type ItemService = ReturnType<typeof createItemService>

/**
 * Item use cases: push, read, update, soft delete, list and audit history.
 * Every write runs in one `storage.transaction` together with its history
 * event(s), so the item and its audit trail never diverge.
 */
export function createItemService(ctx: ServiceContext, actor: Actor) {
  const { storage } = ctx
  const now = () => ctx.clock.now().toISOString()
  const ac = createAccessControl(ctx, actor)

  async function requireTube(repos: Repositories, id: string): Promise<Tube> {
    const tube = await repos.tubes.get(id)
    if (!tube) throw new NotFoundError("Tube", id)
    return tube
  }

  /** Tube that exists AND is in the caller's scope (else 404). */
  async function requireScopedTube(
    repos: Repositories,
    scope: ScopeView,
    id: string
  ): Promise<Tube> {
    const tube = await requireTube(repos, id)
    ac.assertTube(scope, tube)
    return tube
  }

  async function requireItem(repos: Repositories, id: string): Promise<Item> {
    const item = await repos.items.get(id)
    if (!item) throw new NotFoundError("Item", id)
    return item
  }

  /** Item that exists AND whose tube is in the caller's scope (else 404). */
  async function requireScopedItem(
    repos: Repositories,
    scope: ScopeView,
    id: string
  ): Promise<Item> {
    const item = await requireItem(repos, id)
    if (!scope.unrestricted) {
      ac.assertItem(scope, item, await repos.tubes.get(item.tubeId))
    }
    return item
  }

  function requireLive(item: Item) {
    if (item.deletedAt) {
      throw new ConflictError(`Item "${item.id}" is deleted`, {
        deletedAt: item.deletedAt,
      })
    }
  }

  const pushOne = (
    repos: Repositories,
    tube: Tube,
    input: z.output<typeof PushItemInputSchema>
  ) => pushItemInTransaction(ctx, actor, repos, tube, input)

  /**
   * Update of one item inside the caller's transaction. All checks run
   * before the first write, so a rejected entry leaves nothing behind.
   */
  async function updateOne(
    repos: Repositories,
    id: string,
    parsed: z.output<typeof UpdateItemInputSchema>,
    scope: ScopeView
  ): Promise<Item> {
    return (await updateOneChanged(repos, id, parsed, scope)).item
  }

  /** `updateOne` that also tells whether anything was written. */
  async function updateOneChanged(
    repos: Repositories,
    id: string,
    parsed: z.output<typeof UpdateItemInputSchema>,
    scope: ScopeView
  ): Promise<{ item: Item; changed: boolean }> {
    const status = parsed.status
    if (status === "processing") {
      throw new ValidationError(
        'Status "processing" cannot be set manually: only claim_next_item starts processing',
        { status }
      )
    }
    const item = await requireScopedItem(repos, scope, id)
    requireLive(item)
    const ts = now()
    const patch: Patch<Item> = {}
    const oldValues: Record<string, unknown> = {}
    const newValues: Record<string, unknown> = {}
    for (const field of EDITABLE_FIELDS) {
      const value = parsed[field]
      if (value === undefined || isDeepStrictEqual(value, item[field])) {
        continue
      }
      ;(patch as Record<string, unknown>)[field] = value
      oldValues[field] = item[field]
      newValues[field] = value
    }
    if (patch.payload !== undefined) {
      assertPayloadMatchesTube(
        await requireTube(repos, item.tubeId),
        patch.payload
      )
    }
    if (parsed.result !== undefined) {
      // `null` clears the result.
      const result = parsed.result === null ? undefined : parsed.result
      if (!isDeepStrictEqual(result, item.result)) {
        patch.result = result
        oldValues.result = item.result ?? null
        newValues.result = parsed.result
      }
    }

    const statusChanged = status !== undefined && status !== item.status
    const leaseEnded = statusChanged && item.status === "processing"
    if (statusChanged) {
      if (!canTransitionManually(item.status, status)) {
        throw new ConflictError(
          `Invalid status transition ${item.status} → ${status}`,
          { from: item.status, to: status }
        )
      }
      patch.status = status
      // A manual change ends any lease: the former holder can no longer
      // complete / fail / release / heartbeat the item (409).
      if (item.leaseExpiresAt || item.status === "processing") {
        patch.leaseExpiresAt = null
      }
      // Back to the queue: unassigned. `createdAt` is kept, so the item
      // keeps its place. Other targets keep `assignedAgent` for history.
      if (status === "pending" && item.assignedAgent) {
        patch.assignedAgent = null
      }
      if (status === "completed") patch.completedAt = ts
      // A manual status change (incl. "Retry now") drops any backoff delay.
      if (item.retryAt) patch.retryAt = undefined
    }

    if (Object.keys(patch).length === 0) return { item, changed: false } // no-op
    patch.updatedAt = ts
    const updated = await repos.items.update(id, patch)
    if (!updated) throw new NotFoundError("Item", id)
    if (Object.keys(newValues).length > 0) {
      await recordHistory(ctx, repos, actor, {
        itemId: id,
        action: "updated",
        oldValue: oldValues,
        newValue: newValues,
        at: ts,
      })
    }
    if (statusChanged) {
      await recordHistory(ctx, repos, actor, {
        itemId: id,
        action: "status_changed",
        oldValue: {
          status: item.status,
          ...(leaseEnded && {
            assignedAgent: item.assignedAgent ?? null,
            leaseExpiresAt: item.leaseExpiresAt ?? null,
          }),
        },
        newValue: {
          status,
          ...(patch.assignedAgent === null && { assignedAgent: null }),
        },
        at: ts,
      })
    }
    emit(
      ctx,
      itemEvent(
        actor,
        statusChanged ? "status_changed" : "updated",
        item,
        updated
      )
    )
    return { item: updated, changed: true }
  }

  /**
   * Soft delete of one live item inside the caller's transaction: sets
   * `deletedAt`, drops a lease (a `processing` item is deleted anyway; its
   * holder then gets 409), writes a `deleted` history event.
   */
  async function deleteOne(
    repos: Repositories,
    item: Item,
    ts: string
  ): Promise<Item> {
    requireLive(item)
    const dropLease = item.status === "processing" || !!item.leaseExpiresAt
    const updated = await repos.items.update(item.id, {
      deletedAt: ts,
      ...(dropLease && { leaseExpiresAt: null }),
      updatedAt: ts,
    })
    if (!updated) throw new NotFoundError("Item", item.id)
    await recordHistory(ctx, repos, actor, {
      itemId: item.id,
      action: "deleted",
      oldValue: {
        deletedAt: null,
        ...(dropLease && {
          status: item.status,
          assignedAgent: item.assignedAgent ?? null,
          leaseExpiresAt: item.leaseExpiresAt ?? null,
        }),
      },
      newValue: { deletedAt: ts },
      at: ts,
    })
    emit(ctx, itemEvent(actor, "deleted", item, updated))
    return updated
  }

  /**
   * Runs `fn` for every bulk entry inside the caller's transaction. Expected
   * failures (validation, not found, conflict) become per-entry results;
   * anything else aborts — and rolls back — the whole bulk request.
   */
  async function eachEntry(
    entries: unknown[],
    fn: (entry: unknown) => Promise<{ created?: boolean; data: Item }>
  ): Promise<BulkItemResult[]> {
    const results: BulkItemResult[] = []
    for (const [index, entry] of entries.entries()) {
      try {
        results.push({ index, ok: true, ...(await fn(entry)) })
      } catch (error) {
        if (!isExpectedError(error)) throw error
        const id =
          entry && typeof entry === "object" && "id" in entry
            ? String((entry as { id: unknown }).id)
            : undefined
        results.push({
          index,
          ok: false,
          ...(id !== undefined && { id }),
          error: normalizeError(error),
        })
      }
    }
    return results
  }

  /** In-memory search over the (optionally per-tube) item set. */
  async function search(
    tubeId: string | undefined,
    input: z.output<typeof ListItemsInputSchema>
  ): Promise<PageResult<Item>> {
    ac.require("read")
    const { offset, limit, order, includeDeleted, ...filter } = input
    const scope = await ac.view()
    if (tubeId !== undefined) await requireScopedTube(storage, scope, tubeId)
    const base = { ...(tubeId !== undefined && { tubeId }), includeDeleted }
    // A scoped caller searching every tube only sees items of its tubes.
    const allowedTubes =
      tubeId === undefined && !scope.unrestricted
        ? new Set(
            (await storage.tubes.list())
              .filter((t) => scope.canAccessTube(t))
              .map((t) => t.id)
          )
        : undefined
    if (!hasItemFilter(filter) && !allowedTubes) {
      if (order === "desc") {
        const total = await storage.items.count(base)
        const window = descWindow(total, offset, limit)
        const data =
          window.limit > 0
            ? (await storage.items.list({ ...base, ...window })).reverse()
            : []
        return { data, page: { offset, limit, total } }
      }
      const [data, total] = await Promise.all([
        storage.items.list({ ...base, offset, limit }),
        storage.items.count(base),
      ])
      return { data, page: { offset, limit, total } }
    }
    // Status and agent narrow the candidate set in the repo; the rest in memory.
    const candidates = await storage.items.list({
      ...base,
      ...(filter.status?.length && { status: filter.status }),
      ...(filter.assignedAgent !== undefined && {
        assignedAgent: filter.assignedAgent,
      }),
    })
    const matches = candidates.filter(
      (item) =>
        (!allowedTubes || allowedTubes.has(item.tubeId)) &&
        matchesItemFilter(item, filter)
    )
    return {
      data: pageOf(matches, { offset, limit, order }),
      page: { offset, limit, total: matches.length },
    }
  }

  return {
    /** Adds an item to a tube (status `pending`). Idempotent per `idempotencyKey`. */
    async push(tubeId: string, input: unknown): Promise<PushItemResult> {
      IdSchema.parse(tubeId)
      ac.require("items:push")
      const parsed = await withMedia(
        mediaMaterializer(ctx),
        PushItemInputSchema.parse(input)
      )
      return transact(ctx, async (repos) =>
        pushOne(
          repos,
          await requireScopedTube(repos, await ac.view(repos), tubeId),
          parsed
        )
      )
    },

    /**
     * Pushes up to `MAX_BULK_ITEMS` items in ONE transaction (one mutex hold,
     * one persist). Each entry gets the single-push rules (validation,
     * idempotency key, tube schema, disabled tube) and its own result.
     */
    async bulkPush(tubeId: string, input: unknown): Promise<BulkResult> {
      IdSchema.parse(tubeId)
      const { items } = BulkPushItemsInputSchema.parse(input)
      ac.require("items:push")
      const materialize = mediaMaterializer(ctx)
      const prepared: Prepared<z.output<typeof PushItemInputSchema>>[] = []
      for (const entry of items) {
        prepared.push(
          await prepareEntry(undefined, () =>
            withMedia(materialize, PushItemInputSchema.parse(entry))
          )
        )
      }
      const results = await transact(ctx, async (repos) => {
        const tube = await requireScopedTube(
          repos,
          await ac.view(repos),
          tubeId
        )
        return eachEntry(prepared, async (entry) => {
          const { item, created } = await pushOne(repos, tube, unwrap(entry))
          return { created, data: item }
        })
      })
      return summarize(results, true)
    },

    /**
     * Resets a tube: every non-deleted item matching `input` (see
     * `RequeueAllInputSchema`; empty = all) goes back to a fresh `pending`
     * state (any status, incl. processing / completed / archived — active
     * leases are revoked), with assignment, lease, attempts, backoff, result,
     * last error and completion time cleared. Payload, metadata, tags and
     * priority are kept. One transaction; one `reset` history event per
     * changed item. Items already fresh are left untouched.
     */
    async requeueAll(
      tubeId: string,
      input: unknown = {}
    ): Promise<RequeueAllResult> {
      IdSchema.parse(tubeId)
      const filter = RequeueAllInputSchema.parse(input ?? {})
      ac.require("items:manage")
      return transact(ctx, async (repos) => {
        const tube = await requireScopedTube(
          repos,
          await ac.view(repos),
          tubeId
        )
        const items = await repos.items.list({ tubeId: tube.id })
        const matched = hasItemFilter(filter)
          ? items.filter((item) => matchesItemFilter(item, filter))
          : items
        const ts = now()
        let requeued = 0
        for (const item of matched) {
          if (isFresh(item)) continue
          const updated = await repos.items.update(item.id, {
            status: "pending",
            assignedAgent: null,
            leaseExpiresAt: null,
            attempts: 0,
            retryAt: undefined,
            result: undefined,
            lastError: undefined,
            completedAt: undefined,
            updatedAt: ts,
          })
          if (!updated) throw new NotFoundError("Item", item.id)
          await recordHistory(ctx, repos, actor, {
            itemId: item.id,
            action: "reset",
            oldValue: {
              status: item.status,
              attempts: item.attempts,
              assignedAgent: item.assignedAgent ?? null,
            },
            newValue: { status: "pending", attempts: 0 },
            at: ts,
          })
          emit(ctx, itemEvent(actor, "reset", item, updated))
          requeued++
        }
        return { total: items.length, matched: matched.length, requeued }
      })
    },

    /**
     * Items of a tube, `createdAt` ascending (or `order: "desc"`), soft-deleted hidden by
     * default, optionally filtered (see `ListItemsInputSchema`).
     */
    async list(tubeId: string, input: unknown = {}): Promise<PageResult<Item>> {
      IdSchema.parse(tubeId)
      return search(tubeId, ListItemsInputSchema.parse(input))
    },

    /** Like `list`, with `tubeId` optional: omit it to search every tube. */
    async search(input: unknown = {}): Promise<PageResult<Item>> {
      const { tubeId, ...rest } = SearchItemsInputSchema.parse(input)
      return search(tubeId, rest)
    },

    /** Any item by id, including soft-deleted ones (check `deletedAt`). */
    async get(id: string): Promise<Item> {
      ac.require("read")
      return requireScopedItem(storage, await ac.view(), id)
    },

    /**
     * Updates payload / metadata / tags / priority and/or status. Writes one
     * `updated` event (changed fields, old → new) and, if the status changed,
     * one `status_changed` event.
     */
    async update(id: string, input: unknown): Promise<Item> {
      ac.require("items:manage")
      const parsed = await withMedia(
        mediaMaterializer(ctx),
        UpdateItemInputSchema.parse(input)
      )
      return transact(ctx, async (repos) =>
        updateOne(repos, id, parsed, await ac.view(repos))
      )
    },

    /**
     * Updates up to `MAX_BULK_ITEMS` items in ONE transaction (one mutex
     * hold, one persist) with exactly the single-update rules: manual status
     * transitions, payload schema, deleted items rejected, and the same
     * per-item history events. Each entry gets its own result.
     */
    async bulkUpdate(input: unknown): Promise<BulkResult> {
      const parsed = BulkUpdateItemsInputSchema.parse(input)
      if (parsed.tubeId !== undefined) {
        throw new ValidationError(
          "The `tubeId` + `filter` form is handled by updateWhere"
        )
      }
      ac.require("items:manage")
      const materialize = mediaMaterializer(ctx)
      type Changes = z.output<typeof UpdateItemInputSchema>
      const shared =
        parsed.patch && (await withMedia(materialize, parsed.patch))
      const prepared: Prepared<{ id: string; changes: Changes }>[] = []
      if (shared) {
        for (const id of parsed.ids!) {
          prepared.push({ id, input: { id, changes: shared } })
        }
      } else {
        for (const entry of parsed.items!) {
          const rawId =
            entry && typeof entry === "object" && "id" in entry
              ? String((entry as { id: unknown }).id)
              : undefined
          prepared.push(
            await prepareEntry(rawId, async () => {
              const { id, ...rest } = BulkUpdateEntrySchema.parse(entry)
              const changes = UpdateItemInputSchema.parse(rest)
              return { id, changes: await withMedia(materialize, changes) }
            })
          )
        }
      }
      const results = await transact(ctx, async (repos) => {
        const scope = await ac.view(repos)
        return eachEntry(prepared, async (entry) => {
          const { id, changes } = unwrap<{ id: string; changes: Changes }>(
            entry
          )
          return { data: await updateOne(repos, id, changes, scope) }
        })
      })
      return summarize(results, false)
    },

    /**
     * `bulk_update_items { tubeId, filter, patch }`: applies `patch` to every
     * non-deleted item of the tube matching `filter` (see
     * `BulkItemFilterSchema`), server-side, no cap — e.g. "reset all
     * processing → pending". Same rules and history events as `update`;
     * ONE transaction, all or nothing (any rejected item rolls back all).
     * `affected` counts the items actually changed.
     */
    async updateWhere(input: unknown): Promise<BulkUpdateByFilterResult> {
      const parsed = BulkUpdateItemsInputSchema.parse(input)
      if (parsed.tubeId === undefined) {
        throw new ValidationError("`tubeId` + `filter` + `patch` are required")
      }
      ac.require("items:manage")
      const tubeId = parsed.tubeId
      const filter = parsed.filter!
      const patch = await withMedia(mediaMaterializer(ctx), parsed.patch!)
      return transact(ctx, async (repos) => {
        const scope = await ac.view(repos)
        await requireScopedTube(repos, scope, tubeId)
        const candidates = await repos.items.list({
          tubeId,
          ...(filter.status?.length && { status: filter.status }),
        })
        const matched = hasItemFilter(filter)
          ? candidates.filter((item) => matchesItemFilter(item, filter))
          : candidates
        let affected = 0
        for (const item of matched) {
          const { changed } = await updateOneChanged(
            repos,
            item.id,
            patch,
            scope
          )
          if (changed) affected++
        }
        return { affected }
      })
    },

    /**
     * Admin reassignment of `assignedAgent` (see `ReassignItemInputSchema`).
     * Writes one `reassigned` event (old → new agent); same agent = no-op.
     */
    async reassign(id: string, input: unknown): Promise<Item> {
      const { agentId } = ReassignItemInputSchema.parse(input)
      ac.require("items:manage")
      return transact(ctx, async (repos) => {
        const item = await requireScopedItem(repos, await ac.view(repos), id)
        requireLive(item)
        const current = item.assignedAgent ?? null
        if (agentId === current) return item
        if (item.status === "processing" && agentId === null) {
          throw new ConflictError(
            "A processing item needs an agent: release it or change its status instead",
            { status: item.status }
          )
        }
        const ts = now()
        const updated = await repos.items.update(id, {
          assignedAgent: agentId,
          updatedAt: ts,
        })
        if (!updated) throw new NotFoundError("Item", id)
        await recordHistory(ctx, repos, actor, {
          itemId: id,
          action: "reassigned",
          oldValue: { assignedAgent: current },
          newValue: { assignedAgent: agentId },
          at: ts,
        })
        emit(ctx, itemEvent(actor, "reassigned", item, updated))
        return updated
      })
    },

    /** Soft delete: sets `deletedAt`, hides the item from lists, keeps its history. */
    async delete(id: string): Promise<Item> {
      ac.require("items:manage")
      return transact(ctx, async (repos) =>
        deleteOne(
          repos,
          await requireScopedItem(repos, await ac.view(repos), id),
          now()
        )
      )
    },

    /**
     * Soft-deletes many items in ONE transaction with `delete`'s rules
     * (history event per item; `processing` items are deleted too and lose
     * their lease). `{ ids }` (≤ `MAX_BULK_DELETE_IDS`) returns per-item
     * results; `{ tubeId, status? }` deletes every match server-side.
     */
    async bulkDelete(input: unknown): Promise<BulkDeleteResult> {
      const parsed = BulkDeleteItemsInputSchema.parse(input)
      ac.require("items:manage")
      return transact(ctx, async (repos) => {
        const scope = await ac.view(repos)
        const ts = now()
        if (parsed.ids !== undefined) {
          const results = await eachEntry(
            parsed.ids.map((id) => ({ id })),
            async (entry) => {
              const { id } = entry as { id: string }
              const item = await requireScopedItem(repos, scope, id)
              return { data: await deleteOne(repos, item, ts) }
            }
          )
          return {
            deleted: results.filter((r) => r.ok).length,
            results,
          }
        }
        const tubeId = parsed.tubeId!
        await requireScopedTube(repos, scope, tubeId)
        const matched = await repos.items.list({
          tubeId,
          ...(parsed.status?.length && { status: parsed.status }),
        })
        for (const item of matched) await deleteOne(repos, item, ts)
        return { deleted: matched.length }
      })
    },

    /** Audit trail of an item (also of soft-deleted ones), newest first. */
    async history(
      id: string,
      input: unknown = {}
    ): Promise<PageResult<HistoryEvent>> {
      const { offset, limit } = ItemHistoryInputSchema.parse(input)
      ac.require("read")
      await requireScopedItem(storage, await ac.view(), id)
      const [data, total] = await Promise.all([
        storage.history.list({ itemId: id, offset, limit }),
        storage.history.count({ itemId: id }),
      ])
      return { data, page: { offset, limit, total } }
    },
  }
}

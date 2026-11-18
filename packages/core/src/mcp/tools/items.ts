import { z } from "zod"

import {
  PAYLOAD_FILTER_OPERATORS,
  StatusFilterSchema,
} from "../../domain/item-filter"
import type { PageResult } from "../../domain/pagination"
import { IdSchema, type Item } from "../../domain/schemas"
import {
  AgentItemsInputSchema,
  BulkItemFilterSchema,
  ClaimItemInputSchema,
  CompleteItemInputSchema,
  FailItemInputSchema,
  HeartbeatItemInputSchema,
  ItemHistoryInputSchema,
  ListItemsInputSchema,
  MAX_BULK_DELETE_IDS,
  MAX_BULK_ITEMS,
  PushItemInputSchema,
  ReassignItemInputSchema,
  ReleaseItemInputSchema,
  SearchItemsInputSchema,
  UpdateItemInputSchema,
} from "../../services"

import { defineTool, IdArgSchema, splitId } from "./define"
import {
  ItemListOutputSchema,
  ItemProjectionSchema,
  projectItem,
  shapePage,
  splitOutputOptions,
} from "./shape"

const TubeIdArgSchema = z.object({ tubeId: IdSchema })

const PAYLOAD_OPS = PAYLOAD_FILTER_OPERATORS.join("|")

/** Splits `{ tubeId, ...rest }`; throws `ZodError` on a bad tube id. */
function splitTubeId(args: Record<string, unknown>) {
  const { tubeId, ...rest } = args
  return { tubeId: TubeIdArgSchema.parse({ tubeId }).tubeId, rest }
}

/** Output options shared by the list tools (see ./shape.ts). */
const LIST_OPTIONS_NOTE =
  'Options: limit (n items, default 100, max 1000) / offset; order "asc" (oldest first, default) or "desc" (newest first, so limit: 1, order: "desc" is the latest item); fields: ["id", "payload.prompt"] to get only those fields of each item; field: "payload.prompt" to get only that value per item (data becomes a plain array); countOnly: true for just { total }.'

/** Runs a paginated list with the MCP output options applied. */
async function listWithOptions(
  args: Record<string, unknown>,
  list: (input: Record<string, unknown>) => Promise<PageResult<Item>>
) {
  const { input, output } = splitOutputOptions(args)
  // Only the total is needed: read as little as possible.
  const page = await list(
    output.countOnly ? { ...input, offset: 0, limit: 1 } : input
  )
  return shapePage(page, output)
}

const AGENT_NOTE =
  "The agent is the authenticated MCP session (X-Agent-Id header / MCPOCKET_AGENT_ID), not an argument."

/** Manual status rules shared by update_item and bulk_update_items. */
const MANUAL_STATUS_NOTE =
  'status: any status from any status, except "processing" (validation_error: only claim_next_item starts processing). "pending" clears the lease, assignedAgent and retryAt and keeps createdAt, so the item keeps its place in the queue; "completed" / "failed" / "cancelled" / "archived" / "retry" clear the lease and keep assignedAgent for history. After a manual status change the former lease holder\'s complete_item / fail_item / release_item / heartbeat_item answer conflict and change nothing. result: any JSON stored as the item\'s result (null clears it), no lease needed; recorded as an "updated" history event with old and new values.'

const LEASE_NOTE =
  "leaseSeconds: 0 = the lease never expires: the item stays processing until complete_item, fail_item, release_item or a manual status change, is never reclaimed, and claim.leaseExpiresAt is null."

/** Item management tools (plan §5.3). */
export const itemTools = [
  defineTool({
    name: "push_item",
    capability: "items:push",
    title: "Push item",
    description:
      "Insert a JSON object (payload) into a tube as a pending item. The payload must match the tube's schemaDefinition, if any. Media (images, videos, audio, files) goes in as data URIs anywhere in payload or metadata (data:image/png;base64,..., optional ;name=file.png); when media storage is on (mcpocket://system/info → media) each file is uploaded once and replaced by its public URL before the item is stored, so the stored item holds URLs. https URLs are kept as is — they are NOT copied, so for a generator's temporary link call ingest_media first and push the permanent URL it returns. Repeating a push with the same idempotencyKey returns the original item (created: false). Returns { data: Item, created }.",
    input: TubeIdArgSchema.extend(PushItemInputSchema.shape),
    run: async (services, args) => {
      const { tubeId, rest } = splitTubeId(args)
      const { item, created } = await services.items.push(tubeId, rest)
      return { data: item, created }
    },
  }),
  defineTool({
    name: "get_item",
    capability: "read",
    title: "Get item",
    description:
      'Retrieve one item by id (soft-deleted items too; check deletedAt). Optional fields: ["status", "result"] returns only those fields; field: "payload.prompt" returns only that value. Returns { data: Item }.',
    input: IdArgSchema.extend(ItemProjectionSchema.shape),
    annotations: { readOnlyHint: true },
    run: async (services, args) => {
      const { id, rest } = splitId(args)
      const { output } = splitOutputOptions(rest)
      return { data: projectItem(await services.items.get(id), output) }
    },
  }),
  defineTool({
    name: "update_item",
    capability: "items:manage",
    title: "Update item",
    description: `Update an item's payload, metadata, tags (metadata/tags are replaced, not merged), priority, status and/or result. ${MANUAL_STATUS_NOTE} Media data URIs in payload / metadata / result are uploaded and replaced by their URL (see push_item). Returns { data: Item }.`,
    input: IdArgSchema.extend(UpdateItemInputSchema.shape),
    annotations: { idempotentHint: true },
    run: async (services, args) => {
      const { id, rest } = splitId(args)
      return { data: await services.items.update(id, rest) }
    },
  }),
  defineTool({
    name: "reassign_item",
    capability: "items:manage",
    title: "Reassign item",
    description:
      "Admin/operator: set an item's assignedAgent (null unassigns). On a processing item the lease moves to the new agent; unassigning a processing item is rejected. Returns { data: Item }.",
    input: IdArgSchema.extend(ReassignItemInputSchema.shape),
    run: async (services, args) => {
      const { id, rest } = splitId(args)
      return { data: await services.items.reassign(id, rest) }
    },
  }),
  defineTool({
    name: "delete_item",
    capability: "items:manage",
    title: "Delete item",
    description:
      "Soft-delete an item (it disappears from lists and can no longer be claimed; its history is kept). A processing item is deleted too and loses its lease. Returns { deleted: true, id }.",
    input: IdArgSchema,
    annotations: { destructiveHint: true, idempotentHint: false },
    run: async (services, args) => {
      const { id } = splitId(args)
      await services.items.delete(id)
      return { deleted: true, id }
    },
  }),
  defineTool({
    name: "list_items",
    capability: "read",
    title: "List items",
    description: `Browse the items of a tube (paginated, oldest first; includeDeleted to show soft-deleted ones; accepts the same filters as search_items). ${LIST_OPTIONS_NOTE} Returns { data: Item[], page: { offset, limit, total } }.`,
    input: TubeIdArgSchema.extend(ListItemsInputSchema.shape).extend(
      ItemListOutputSchema.shape
    ),
    annotations: { readOnlyHint: true },
    run: (services, args) => {
      const { tubeId, rest } = splitTubeId(args)
      return listWithOptions(rest, (input) =>
        services.items.list(tubeId, input)
      )
    },
  }),
  defineTool({
    name: "search_items",
    capability: "read",
    title: "Search items",
    description: `Find items by any combination of filters (AND), in one tube (tubeId) or across all tubes: status (one, array or comma list), assignedAgent, createdFrom/createdTo (ISO datetime or YYYY-MM-DD, inclusive), priority / priorityMin / priorityMax, tags (item must have all), payload: [{ path: "customer.address.city", op?, value }] where path is dotted (numeric segments index arrays) and op is ${PAYLOAD_OPS} (default eq; scalars compare loosely, "42" = 42; in takes an array; exists takes a boolean; contains = case-insensitive substring or array element; gt/gte/lt/lte compare numbers numerically, strings lexically). Paginated, oldest first. ${LIST_OPTIONS_NOTE} Returns { data: Item[], page: { offset, limit, total } } (total = all matches).`,
    input: SearchItemsInputSchema.extend(ItemListOutputSchema.shape),
    annotations: { readOnlyHint: true },
    run: (services, args) =>
      listWithOptions(args, (input) => services.items.search(input)),
  }),
  defineTool({
    name: "bulk_push_items",
    capability: "items:push",
    title: "Bulk push items",
    description: `Insert up to ${MAX_BULK_ITEMS} items into a tube in one atomic write. Each entry follows push_item's rules (schema validation, idempotencyKey) and gets its own result; failures do not stop the others. Media data URIs in payload / metadata are uploaded and replaced by their URL (see push_item). Returns { results: [{ index, ok: true, created, data } | { index, ok: false, error }], summary: { total, succeeded, failed, created } }.`,
    input: TubeIdArgSchema.extend({
      items: z.array(PushItemInputSchema).min(1).max(MAX_BULK_ITEMS),
    }),
    run: (services, args) => {
      const { tubeId, rest } = splitTubeId(args)
      return services.items.bulkPush(tubeId, rest)
    },
  }),
  defineTool({
    name: "bulk_update_items",
    capability: "items:manage",
    title: "Bulk update items",
    description: `Update many items in one atomic write, in one of three forms: per-item changes { items: [{ id, payload?, metadata?, tags?, priority?, status?, result? }] } or one change for many { ids: [...], patch: { ... } } (up to ${MAX_BULK_ITEMS} entries; each entry gets its own result), or one change for every item of a tube matching a filter { tubeId, filter: { status?, assignedAgent?, tags?, priority*, created*, payload? }, patch } (server-side, no cap, all or nothing; e.g. reset all processing → pending with filter: { status: "processing" }, patch: { status: "pending" }). Same rules and history events as update_item (${MANUAL_STATUS_NOTE}). Media data URIs in payload / metadata / result are uploaded and replaced by their URL (see push_item). Returns { results: [{ index, ok: true, data } | { index, ok: false, id?, error }], summary: { total, succeeded, failed } }, or { affected } (items actually changed) for the filter form.`,
    input: z.object({
      items: z
        .array(IdArgSchema.extend(UpdateItemInputSchema.shape))
        .min(1)
        .max(MAX_BULK_ITEMS)
        .optional(),
      ids: z.array(IdSchema).min(1).max(MAX_BULK_ITEMS).optional(),
      tubeId: IdSchema.optional(),
      filter: BulkItemFilterSchema.optional(),
      patch: UpdateItemInputSchema.optional(),
    }),
    run: (services, args) =>
      args.tubeId !== undefined || args.filter !== undefined
        ? services.items.updateWhere(args)
        : services.items.bulkUpdate(args),
  }),
  defineTool({
    name: "bulk_delete_items",
    capability: "items:manage",
    title: "Bulk delete items",
    description: `Soft-delete many items in one atomic write, with delete_item's rules (a "deleted" history event per item; processing items are deleted too and lose their lease). Either { ids: [...] } (up to ${MAX_BULK_DELETE_IDS}; each id gets its own result) or { tubeId, status? } — every non-deleted item of the tube, optionally only these statuses (one, an array or a comma list), server-side, no cap. Returns { deleted, results? } (results only for the ids form: [{ index, ok: true, data } | { index, ok: false, id, error }]).`,
    input: z.object({
      ids: z.array(IdSchema).min(1).max(MAX_BULK_DELETE_IDS).optional(),
      tubeId: IdSchema.optional(),
      status: StatusFilterSchema.optional(),
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    run: (services, args) => services.items.bulkDelete(args),
  }),
]

/** Agent processing tools (plan §5.4). All lease rules match the REST API. */
export const processingTools = [
  defineTool({
    name: "claim_next_item",
    capability: "items:process",
    title: "Claim next item",
    description: `Atomically claim the next item of a tube (pending, retry whose backoff retryAt has passed, or an expired lease while attempts remain; highest priority, then oldest) and lease it to you for leaseSeconds (default: the tube's leaseSeconds, else the server default; claim.leaseExpiresAt tells you the deadline). ${LEASE_NOTE} ${AGENT_NOTE} Optional fields: ["payload"] / field: "payload.prompt" trims data to what you need (claim.itemId always holds the id). Returns { claimed: true, data: Item, claim: { itemId, agentId, claimedAt, leaseExpiresAt, attempts } } or { claimed: false, data: null, message } when there is nothing to claim.`,
    input: ClaimItemInputSchema.extend(ItemProjectionSchema.shape),
    run: async (services, args) => {
      const { input, output } = splitOutputOptions(args)
      const result = await services.processing.claim(input)
      if (!result) {
        return { claimed: false, data: null, message: "Nothing to claim" }
      }
      return {
        claimed: true,
        data: projectItem(result.item, output),
        claim: result.claim,
      }
    },
  }),
  defineTool({
    name: "complete_item",
    capability: "items:process",
    title: "Complete item",
    description: `Complete an item you hold a live lease on and store an optional JSON result. Optional next: one or a list (≤ 100) of { tubeId, payload, priority?, tags?, metadata?, idempotencyKey? } — each adds a new pending item to an existing tube (no tube is created), in the same atomic write as the completion. Use it to hand your output to the next stage of a pipeline (e.g. prompts → images → videos → captions): put the generated media in the next payload as URLs (from ingest_media / create_media_upload, or already-stored media URLs) or as data URIs (data:image/png;base64,..., uploaded once and replaced by their URL in result and next alike), and copy forward the fields later stages need (e.g. the original prompt). Each new item gets metadata.source = { tubeId, itemId, root: { tubeId, itemId } } — this item and the first item of the chain. Targets must be in your scope, or listed in this item's tube nextTubeIds. If any next item is rejected (unknown/disabled tube, schema mismatch), nothing is written and you keep the lease. ${AGENT_NOTE} Returns { data: Item, next?: Item[] } (next = the created items, with media as URLs).`,
    input: IdArgSchema.extend(CompleteItemInputSchema.shape),
    run: async (services, args) => {
      const { id, rest } = splitId(args)
      const { item, next } = await services.processing.completeWithNext(
        id,
        rest
      )
      return { data: item, ...(next.length > 0 && { next }) }
    },
  }),
  defineTool({
    name: "fail_item",
    capability: "items:process",
    title: "Fail item",
    description: `Mark an item you hold a live lease on as failed. error is a message or { message, code?, details? } (stored as lastError); optional result is any JSON stored as the item's result (like complete_item's), next to the error. While the tube's retry policy has attempts left the item goes to "retry" and becomes claimable again after a backoff (retryAt); otherwise it stays "failed". ${AGENT_NOTE} Returns { data: Item }.`,
    input: IdArgSchema.extend(FailItemInputSchema.shape),
    run: async (services, args) => {
      const { id, rest } = splitId(args)
      return { data: await services.processing.fail(id, rest) }
    },
  }),
  defineTool({
    name: "release_item",
    capability: "items:process",
    title: "Release item",
    description: `Give an item you hold a live lease on back to the tube (status pending) with an optional reason. ${AGENT_NOTE} Returns { data: Item }.`,
    input: IdArgSchema.extend(ReleaseItemInputSchema.shape),
    run: async (services, args) => {
      const { id, rest } = splitId(args)
      return { data: await services.processing.release(id, rest) }
    },
  }),
  defineTool({
    name: "heartbeat_item",
    capability: "items:process",
    title: "Heartbeat item",
    description: `Renew your lease on an item you are processing (leaseSeconds from now; default: the tube's leaseSeconds, else the server default; 0 = never expires). Heartbeat during long work (e.g. while polling a video generation job). Call it well before leaseExpiresAt, or another agent may reclaim the item. ${AGENT_NOTE} Returns { data: Item }.`,
    input: IdArgSchema.extend(HeartbeatItemInputSchema.shape),
    run: async (services, args) => {
      const { id, rest } = splitId(args)
      return { data: await services.processing.heartbeat(id, rest) }
    },
  }),
  defineTool({
    name: "get_my_items",
    capability: "items:process",
    title: "Get my items",
    description: `Items assigned to you (live leases plus items you completed/failed), optionally filtered by status (one, an array or a comma list). ${LIST_OPTIONS_NOTE} ${AGENT_NOTE} Returns { data: Item[], page: { offset, limit, total } }.`,
    input: AgentItemsInputSchema.extend(ItemListOutputSchema.shape),
    annotations: { readOnlyHint: true },
    run: (services, args) =>
      listWithOptions(args, (input) => services.processing.myItems(input)),
  }),
  defineTool({
    name: "get_item_history",
    capability: "read",
    title: "Get item history",
    description:
      "The audit trail of an item, newest first (created, updated, status_changed, claimed, heartbeat, completed, failed, released, deleted — each with actor, oldValue/newValue). Returns { data: HistoryEvent[], page: { offset, limit, total } }.",
    input: IdArgSchema.extend(ItemHistoryInputSchema.shape),
    annotations: { readOnlyHint: true },
    run: (services, args) => {
      const { id, rest } = splitId(args)
      return services.items.history(id, rest)
    },
  }),
]

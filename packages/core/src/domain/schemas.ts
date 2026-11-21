import { z } from "zod"

import { AccessScopeSchema, RoleSchema } from "./access"
import { RetryPolicySchema } from "./retry-policy"

/**
 * Domain model (plan §7.1). Defined once as Zod schemas; TypeScript types are
 * inferred. Shared by storage adapters, application services, REST and MCP.
 */

export const IdSchema = z.uuid()
export const TimestampSchema = z.iso.datetime({ offset: true })
export const JsonObjectSchema = z.record(z.string(), z.unknown())

/** Upper bound of any lease (claim / heartbeat / tube default), 24 h. */
export const MAX_LEASE_SECONDS = 86_400
/**
 * Lease length in seconds: 1..`MAX_LEASE_SECONDS`, or `0` = the lease never
 * expires (the item stays `processing` until complete / fail / release or a
 * manual status change; `leaseExpiresAt` is `null`).
 */
export const LeaseSecondsSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(MAX_LEASE_SECONDS)

/** Max pipeline hand-off targets per tube (`Tube.nextTubeIds`). */
export const MAX_NEXT_TUBES = 20

export const ITEM_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "retry",
  "cancelled",
  "archived",
] as const

export const ItemStatusSchema = z.enum(ITEM_STATUSES)
export type ItemStatus = z.infer<typeof ItemStatusSchema>

export const FolderSchema = z.object({
  id: IdSchema,
  parentId: IdSchema.nullable(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type Folder = z.infer<typeof FolderSchema>

/** Max length of `Tube.instructions`. */
export const MAX_TUBE_INSTRUCTIONS = 50_000
/** Max blocks in `Tube.memory`. */
export const MAX_TUBE_MEMORY_BLOCKS = 200
/** Max length of one memory block's text. */
export const MAX_TUBE_MEMORY_TEXT = 10_000

export const TubeMemoryTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TUBE_MEMORY_TEXT)

/** One memory block of a tube (`Tube.memory`). */
export const TubeMemoryBlockSchema = z.object({
  id: IdSchema,
  text: TubeMemoryTextSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type TubeMemoryBlock = z.infer<typeof TubeMemoryBlockSchema>

export const TubeSchema = z.object({
  id: IdSchema,
  /** Containing folder; `null` = top level (folders are optional). */
  folderId: IdSchema.nullable(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  enabled: z.boolean(),
  /** Optional JSON Schema that item payloads must satisfy. */
  schemaDefinition: JsonObjectSchema.optional(),
  /** Retry overrides; missing fields use the global defaults. */
  retryPolicy: RetryPolicySchema.optional(),
  /**
   * Default lease (seconds) for claims / heartbeats in this tube, e.g. long
   * video jobs; `0` = leases never expire; unset = the server default
   * (`MCPOCKET_LEASE_SECONDS`).
   */
  leaseSeconds: LeaseSecondsSchema.optional(),
  /**
   * Pipeline: the tubes this tube's agents hand their output to
   * (`complete_item` `next`). Tube-scoped MCP connections may push into
   * them although they cannot see them otherwise.
   */
  nextTubeIds: z.array(IdSchema).max(MAX_NEXT_TUBES).optional(),
  /**
   * How to work this tube (like a skill: free text / Markdown). Shown to
   * agents on tube-scoped MCP connections and by `get_tube_context`.
   */
  instructions: z.string().max(MAX_TUBE_INSTRUCTIONS).optional(),
  /** Notes agents and users keep about the tube, oldest first. */
  memory: z.array(TubeMemoryBlockSchema).max(MAX_TUBE_MEMORY_BLOCKS).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type Tube = z.infer<typeof TubeSchema>

/** Error info stored by `fail` (processing API). */
export const ItemErrorSchema = z.object({
  message: z.string().min(1),
  code: z.string().optional(),
  details: z.unknown().optional(),
  /** When the failure was reported. */
  at: TimestampSchema,
  /** Attempt number (`attempts` at failure time). */
  attempt: z.number().int().nonnegative(),
  /** Agent that reported the failure. */
  agentId: z.string().optional(),
})
export type ItemError = z.infer<typeof ItemErrorSchema>

export const ItemSchema = z.object({
  id: IdSchema,
  tubeId: IdSchema,
  status: ItemStatusSchema,
  payload: JsonObjectSchema,
  result: z.unknown().optional(),
  /** Last failure reported via `fail` (kept for inspection after requeue). */
  lastError: ItemErrorSchema.nullable().optional(),
  metadata: JsonObjectSchema,
  tags: z.array(z.string()),
  priority: z.number().int(),
  assignedAgent: z.string().nullable().optional(),
  /** Lease deadline of a `processing` item; `null` = the lease never expires. */
  leaseExpiresAt: TimestampSchema.nullable().optional(),
  attempts: z.number().int().nonnegative(),
  /** `retry` items are not claimable before this time (backoff). */
  retryAt: TimestampSchema.nullable().optional(),
  idempotencyKey: z.string().min(1).optional(),
  /** Soft delete marker. */
  deletedAt: TimestampSchema.nullable().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.nullable().optional(),
})
export type Item = z.infer<typeof ItemSchema>

export const HistoryEventSchema = z.object({
  id: IdSchema,
  itemId: IdSchema,
  /** created | updated | status_changed | claimed | deleted | ... */
  action: z.string().min(1),
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
  /** User id, API key id or agent id. */
  actor: z.string().min(1),
  createdAt: TimestampSchema,
})
export type HistoryEvent = z.infer<typeof HistoryEventSchema>

/** Public API key id: the actor id (`api_key:<id>`), chosen at creation, immutable. */
export const ApiKeyIdSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    "1-64 chars of A-Z a-z 0-9 . _ - (starting with a letter or digit)"
  )

/** Agent identity (REST `X-Agent-Id`, MCP session). */
export const AgentIdentitySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:@-]{1,128}$/, "1-128 chars of A-Z a-z 0-9 . _ : @ -")

/**
 * API key managed from the dashboard / REST (ticket 16). Only the SHA-256 of
 * the secret is stored; the secret itself is shown once on creation/rotation.
 */
/**
 * Whether a key's secret can be shown again: `once` (default) shows it only
 * on create / rotate and keeps just its hash; `always` also stores it in
 * clear so admins can copy it (and ready-made URLs) later.
 */
export const SecretVisibilitySchema = z.enum(["once", "always"])
export type SecretVisibility = z.infer<typeof SecretVisibilitySchema>

export const ApiKeyRecordSchema = z.object({
  id: ApiKeyIdSchema,
  description: z.string().max(500).optional(),
  role: RoleSchema,
  /** `null`: unrestricted. Admin keys are always unrestricted. */
  scope: AccessScopeSchema.nullable(),
  /** Agent identity bound to the key: requests act as this agent. */
  agentId: AgentIdentitySchema.nullable().optional(),
  /** Requests per minute; unset → `MCPOCKET_RATE_LIMIT_PER_MINUTE`; 0 = unlimited. */
  rateLimitPerMinute: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .nullable()
    .optional(),
  /** Hex SHA-256 of the secret. Never returned by services. */
  secretHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** First characters of the secret, to recognise it (`mcp_AbCd…`). */
  secretPrefix: z.string().max(16),
  /** Unset = `once`. */
  secretVisibility: SecretVisibilitySchema.optional(),
  /** Clear-text secret, kept only for `secretVisibility: "always"`. Never in views. */
  secret: z.string().max(200).optional(),
  createdBy: z.string().min(1),
  revokedAt: TimestampSchema.nullable().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ApiKeyRecord = z.infer<typeof ApiKeyRecordSchema>

/** Access audit log entry: API key and permission changes (append-only). */
export const AuditEventSchema = z.object({
  id: IdSchema,
  /** e.g. api_key.created | api_key.updated | api_key.secret_rotated | api_key.revoked | api_key.deleted */
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
  actor: z.string().min(1),
  createdAt: TimestampSchema,
})
export type AuditEvent = z.infer<typeof AuditEventSchema>

/**
 * Webhook event types a subscription can select (ticket 17): the item domain
 * events. An empty `eventTypes` list means "all item events".
 * (Kept in sync with ITEM_EVENT_TYPES in lib/events/types.ts.)
 */
export const WEBHOOK_EVENT_TYPES = [
  "item.created",
  "item.updated",
  "item.status_changed",
  "item.deleted",
] as const
export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES)
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>

/** Test deliveries (`POST /api/webhooks/{id}/test`) use this type. */
export const WEBHOOK_PING_EVENT = "webhook.ping"

export const WebhookUrlSchema = z
  .url({ protocol: /^https?$/, error: "Must be an http(s) URL" })
  .max(2000)

/**
 * Webhook subscription (ticket 17). `secret` signs every payload
 * (HMAC-SHA256); it has to be stored in clear to sign, but services never
 * return it after creation / rotation.
 */
export const WebhookSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(100),
  url: WebhookUrlSchema,
  /** Empty: every item event type. */
  eventTypes: z.array(WebhookEventTypeSchema),
  /** Only items in this folder's subtree (null/absent: everywhere). */
  folderId: IdSchema.nullable().optional(),
  /** Only items of this tube (null/absent: everywhere). */
  tubeId: IdSchema.nullable().optional(),
  enabled: z.boolean(),
  secret: z.string().min(16).max(200),
  createdBy: z.string().min(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type Webhook = z.infer<typeof WebhookSchema>

export const WEBHOOK_DELIVERY_STATUSES = [
  "pending",
  "delivered",
  "dead",
] as const
export const WebhookDeliveryStatusSchema = z.enum(WEBHOOK_DELIVERY_STATUSES)
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>

/** One HTTP attempt of a delivery. */
export const WebhookAttemptSchema = z.object({
  at: TimestampSchema,
  /** HTTP status, or null when no response arrived (network error / timeout). */
  statusCode: z.number().int().nullable(),
  ok: z.boolean(),
  durationMs: z.number().int().min(0),
  error: z.string().max(1000).nullable(),
  /** First bytes of the response body. */
  responseBody: z.string().max(1000).nullable().optional(),
})
export type WebhookAttempt = z.infer<typeof WebhookAttemptSchema>

/**
 * Transactional outbox row (ticket 17): one per (event, subscription),
 * written in the same storage transaction as the change that caused it, then
 * delivered by the background dispatcher (at-least-once).
 */
export const WebhookDeliverySchema = z.object({
  id: IdSchema,
  webhookId: IdSchema,
  /** Shared by every delivery of the same event (consumers can dedupe on it). */
  eventId: IdSchema,
  eventType: z.string().min(1),
  /** The exact JSON body sent (signed). */
  payload: JsonObjectSchema,
  status: WebhookDeliveryStatusSchema,
  attempts: z.number().int().min(0),
  /** When the dispatcher may (re)try; null once delivered / dead. */
  nextAttemptAt: TimestampSchema.nullable(),
  lastAttemptAt: TimestampSchema.nullable().optional(),
  deliveredAt: TimestampSchema.nullable().optional(),
  lastError: z.string().max(1000).nullable().optional(),
  /** Most recent attempts (bounded). */
  attemptLog: z.array(WebhookAttemptSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>

/** Shape of `mock/seed.json` and of a full data snapshot. */
export const DatasetSchema = z.object({
  folders: z.array(FolderSchema),
  tubes: z.array(TubeSchema),
  items: z.array(ItemSchema),
  history: z.array(HistoryEventSchema).default([]),
  apiKeys: z.array(ApiKeyRecordSchema).default([]),
  audit: z.array(AuditEventSchema).default([]),
  webhooks: z.array(WebhookSchema).default([]),
  webhookDeliveries: z.array(WebhookDeliverySchema).default([]),
})
export type Dataset = z.infer<typeof DatasetSchema>

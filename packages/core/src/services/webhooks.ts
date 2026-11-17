import { isDeepStrictEqual } from "node:util"

import { z } from "zod"

import { actorToString, type Actor } from "../domain/actor"
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../domain/errors"
import { PageInputSchema, type PageResult } from "../domain/pagination"
import {
  IdSchema,
  WEBHOOK_PING_EVENT,
  WebhookDeliveryStatusSchema,
  WebhookEventTypeSchema,
  WebhookUrlSchema,
  type AuditEvent,
  type Webhook,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookEventType,
} from "../domain/schemas"
import type { Patch, Repositories } from "../storage"
import { generateWebhookSecret } from "../webhooks/signature"

import { requireCapability } from "./access"
import type { ServiceContext } from "./context"
import { transact } from "./events"
import { newDelivery, type WebhookPayload } from "./webhook-outbox"

const NameSchema = z.string().trim().min(1).max(100)
const EventTypesSchema = z
  .array(WebhookEventTypeSchema)
  .max(20)
  .transform((types) => [...new Set(types)])

const scopeRefine = {
  check: (input: { folderId?: string | null; tubeId?: string | null }) =>
    !(input.folderId && input.tubeId),
  message: "Scope a webhook to a folder OR a tube, not both",
}

export const CreateWebhookInputSchema = z
  .strictObject({
    name: NameSchema,
    url: WebhookUrlSchema,
    /** Item event types; empty/omitted = all. */
    eventTypes: EventTypesSchema.default([]),
    /** Only items below this folder (subtree). */
    folderId: IdSchema.nullable().optional(),
    /** Only items of this tube. */
    tubeId: IdSchema.nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .refine(scopeRefine.check, {
    message: scopeRefine.message,
    path: ["tubeId"],
  })
export type CreateWebhookInput = z.input<typeof CreateWebhookInputSchema>

export const UpdateWebhookInputSchema = z
  .strictObject({
    name: NameSchema.optional(),
    url: WebhookUrlSchema.optional(),
    eventTypes: EventTypesSchema.optional(),
    /** `null` clears. */
    folderId: IdSchema.nullable().optional(),
    /** `null` clears. */
    tubeId: IdSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((input) => Object.values(input).some((v) => v !== undefined), {
    message:
      "At least one of name, url, eventTypes, folderId, tubeId, enabled is required",
  })
export type UpdateWebhookInput = z.input<typeof UpdateWebhookInputSchema>

/** One status, an array or a comma list (`pending,dead`). */
const DeliveryStatusFilterSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((v, ctx) => {
    const list = (Array.isArray(v) ? v : v.split(","))
      .map((s) => s.trim())
      .filter(Boolean)
    const parsed = z.array(WebhookDeliveryStatusSchema).safeParse(list)
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: "Invalid status filter" })
      return z.NEVER
    }
    return parsed.data
  })

export const ListWebhookDeliveriesInputSchema = PageInputSchema.extend({
  webhookId: IdSchema.optional(),
  status: DeliveryStatusFilterSchema.optional(),
})
export type ListWebhookDeliveriesInput = z.input<
  typeof ListWebhookDeliveriesInputSchema
>

export type WebhookDeliveryCounts = Record<WebhookDeliveryStatus, number>

/** A subscription as returned by services: never the secret. */
export type WebhookView = {
  id: string
  name: string
  url: string
  eventTypes: WebhookEventType[]
  folderId: string | null
  tubeId: string | null
  enabled: boolean
  /** First characters of the secret, to recognise it (`whsec_AbCd`). */
  secretPrefix: string
  deliveries: WebhookDeliveryCounts
  createdBy: string
  createdAt: string
  updatedAt: string
}

/** Result of create / rotate: the secret is returned exactly once. */
export type WebhookWithSecret = { webhook: WebhookView; secret: string }

const SECRET_PREFIX_LENGTH = "whsec_".length + 4

const emptyCounts = (): WebhookDeliveryCounts => ({
  pending: 0,
  delivered: 0,
  dead: 0,
})

export function toWebhookView(
  webhook: Webhook,
  deliveries: WebhookDeliveryCounts = emptyCounts()
): WebhookView {
  return {
    id: webhook.id,
    name: webhook.name,
    url: webhook.url,
    eventTypes: webhook.eventTypes,
    folderId: webhook.folderId ?? null,
    tubeId: webhook.tubeId ?? null,
    enabled: webhook.enabled,
    secretPrefix: webhook.secret.slice(0, SECRET_PREFIX_LENGTH),
    deliveries,
    createdBy: webhook.createdBy,
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
  }
}

/** Audit snapshot: the settings, never the secret. */
const auditSnapshot = (w: Webhook | WebhookView) => ({
  name: w.name,
  url: w.url,
  eventTypes: w.eventTypes,
  folderId: w.folderId ?? null,
  tubeId: w.tubeId ?? null,
  enabled: w.enabled,
})

export type WebhookService = ReturnType<typeof createWebhookService>

/**
 * Webhook subscriptions + their delivery log (ticket 17). Admin only
 * (`access:manage`, like API keys); every change writes an access audit
 * event (`webhook.*`, targetType `webhook`) in the same transaction.
 * Deliveries themselves are created by the transactional outbox
 * (webhook-outbox.ts) and sent by the dispatcher (webhook-dispatcher.ts).
 */
export function createWebhookService(ctx: ServiceContext, actor: Actor) {
  const { storage } = ctx
  const now = () => ctx.clock.now().toISOString()
  const admin = () => requireCapability(actor, "access:manage")

  async function audit(
    repos: Repositories,
    event: Omit<AuditEvent, "id" | "actor" | "createdAt" | "targetType"> & {
      at: string
    }
  ) {
    const { at, ...rest } = event
    await repos.audit.append({
      id: ctx.newId(),
      targetType: "webhook",
      actor: actorToString(actor),
      createdAt: at,
      ...rest,
    })
  }

  async function requireWebhook(
    repos: Pick<Repositories, "webhooks">,
    id: string
  ): Promise<Webhook> {
    IdSchema.parse(id)
    const webhook = await repos.webhooks.get(id)
    if (!webhook) throw new NotFoundError("Webhook", id)
    return webhook
  }

  async function counts(
    repos: Pick<Repositories, "webhookDeliveries">,
    webhookId: string
  ): Promise<WebhookDeliveryCounts> {
    const result = emptyCounts()
    for (const status of WebhookDeliveryStatusSchema.options) {
      result[status] = await repos.webhookDeliveries.count({
        webhookId,
        status,
      })
    }
    return result
  }

  async function view(
    repos: Pick<Repositories, "webhookDeliveries">,
    webhook: Webhook
  ): Promise<WebhookView> {
    return toWebhookView(webhook, await counts(repos, webhook.id))
  }

  /** Scope targets must exist. */
  async function assertScope(
    repos: Repositories,
    folderId: string | null | undefined,
    tubeId: string | null | undefined
  ) {
    if (folderId && tubeId) {
      throw new ValidationError(scopeRefine.message, [
        { path: "tubeId", message: scopeRefine.message },
      ])
    }
    if (folderId && !(await repos.folders.get(folderId))) {
      throw new NotFoundError("Folder", folderId)
    }
    if (tubeId && !(await repos.tubes.get(tubeId))) {
      throw new NotFoundError("Tube", tubeId)
    }
  }

  const service = {
    /** All subscriptions (oldest first) with delivery counts. */
    async list(): Promise<WebhookView[]> {
      admin()
      const webhooks = await storage.webhooks.list()
      return Promise.all(webhooks.map((w) => view(storage, w)))
    },

    async get(id: string): Promise<WebhookView> {
      admin()
      return view(storage, await requireWebhook(storage, id))
    },

    /** Creates a subscription; the returned `secret` is never retrievable again. */
    async create(input: unknown): Promise<WebhookWithSecret> {
      admin()
      const parsed = CreateWebhookInputSchema.parse(input)
      const secret = generateWebhookSecret()
      return transact(ctx, async (repos) => {
        await assertScope(repos, parsed.folderId, parsed.tubeId)
        const ts = now()
        const webhook = await repos.webhooks.create({
          id: ctx.newId(),
          name: parsed.name,
          url: parsed.url,
          eventTypes: parsed.eventTypes,
          folderId: parsed.folderId ?? null,
          tubeId: parsed.tubeId ?? null,
          enabled: parsed.enabled,
          secret,
          createdBy: actorToString(actor),
          createdAt: ts,
          updatedAt: ts,
        })
        await audit(repos, {
          action: "webhook.created",
          targetId: webhook.id,
          newValue: auditSnapshot(webhook),
          at: ts,
        })
        return { webhook: toWebhookView(webhook), secret }
      })
    },

    /** Changes name / URL / event types / scope / enabled (null clears scope). */
    async update(id: string, input: unknown): Promise<WebhookView> {
      admin()
      const parsed = UpdateWebhookInputSchema.parse(input)
      return transact(ctx, async (repos) => {
        const webhook = await requireWebhook(repos, id)
        const patch: Patch<Webhook> = {}
        if (parsed.name !== undefined) patch.name = parsed.name
        if (parsed.url !== undefined) patch.url = parsed.url
        if (parsed.eventTypes !== undefined) {
          patch.eventTypes = parsed.eventTypes
        }
        if (parsed.enabled !== undefined) patch.enabled = parsed.enabled
        if (parsed.folderId !== undefined) patch.folderId = parsed.folderId
        if (parsed.tubeId !== undefined) patch.tubeId = parsed.tubeId
        // Setting one scope kind replaces the other.
        if (parsed.folderId && parsed.tubeId === undefined) patch.tubeId = null
        if (parsed.tubeId && parsed.folderId === undefined) {
          patch.folderId = null
        }
        const candidate = { ...webhook, ...patch } as Webhook
        await assertScope(repos, candidate.folderId, candidate.tubeId)
        if (
          isDeepStrictEqual(auditSnapshot(webhook), auditSnapshot(candidate))
        ) {
          return view(repos, webhook) // no-op
        }
        const ts = now()
        const updated = await repos.webhooks.update(id, {
          ...patch,
          updatedAt: ts,
        })
        if (!updated) throw new NotFoundError("Webhook", id)
        await audit(repos, {
          action: "webhook.updated",
          targetId: id,
          oldValue: auditSnapshot(webhook),
          newValue: auditSnapshot(updated),
          at: ts,
        })
        return view(repos, updated)
      })
    },

    /** New signing secret (the old one stops being used immediately); returned once. */
    async rotateSecret(id: string): Promise<WebhookWithSecret> {
      admin()
      const secret = generateWebhookSecret()
      return transact(ctx, async (repos) => {
        const webhook = await requireWebhook(repos, id)
        const ts = now()
        const updated = await repos.webhooks.update(id, {
          secret,
          updatedAt: ts,
        })
        if (!updated) throw new NotFoundError("Webhook", id)
        await audit(repos, {
          action: "webhook.secret_rotated",
          targetId: id,
          oldValue: { secretPrefix: toWebhookView(webhook).secretPrefix },
          newValue: { secretPrefix: toWebhookView(updated).secretPrefix },
          at: ts,
        })
        return { webhook: await view(repos, updated), secret }
      })
    },

    /** Removes the subscription and its outbox / delivery log. */
    async delete(id: string): Promise<void> {
      admin()
      await transact(ctx, async (repos) => {
        const webhook = await requireWebhook(repos, id)
        const deliveries = await repos.webhookDeliveries.list({ webhookId: id })
        for (const d of deliveries) await repos.webhookDeliveries.delete(d.id)
        await repos.webhooks.delete(id)
        await audit(repos, {
          action: "webhook.deleted",
          targetId: id,
          oldValue: auditSnapshot(webhook),
          newValue: { deliveriesRemoved: deliveries.length },
          at: now(),
        })
      })
    },

    /** Queues a `webhook.ping` delivery (sent by the dispatcher like any other). */
    async test(id: string): Promise<WebhookDelivery> {
      admin()
      return transact(ctx, async (repos) => {
        const webhook = await requireWebhook(repos, id)
        if (!webhook.enabled) {
          throw new ConflictError(`Webhook "${webhook.name}" is disabled`, {
            enabled: false,
          })
        }
        const ts = now()
        const payload: WebhookPayload = {
          id: ctx.newId(),
          type: WEBHOOK_PING_EVENT,
          createdAt: ts,
          data: {
            webhookId: webhook.id,
            message: "Test delivery from MCPocket",
            actor: actorToString(actor),
          },
        }
        return repos.webhookDeliveries.create(
          newDelivery(ctx, webhook.id, payload, ts)
        )
      })
    },

    /** Delivery log / outbox, newest first; filter by webhook and status. */
    async deliveries(
      input: unknown = {}
    ): Promise<PageResult<WebhookDelivery>> {
      admin()
      const { offset, limit, webhookId, status } =
        ListWebhookDeliveriesInputSchema.parse(input)
      const query = { webhookId, status }
      const [data, total] = await Promise.all([
        storage.webhookDeliveries.list({
          ...query,
          offset,
          limit,
          newestFirst: true,
        }),
        storage.webhookDeliveries.count(query),
      ])
      return { data, page: { offset, limit, total } }
    },

    async delivery(id: string): Promise<WebhookDelivery> {
      admin()
      IdSchema.parse(id)
      const delivery = await storage.webhookDeliveries.get(id)
      if (!delivery) throw new NotFoundError("Webhook delivery", id)
      return delivery
    },

    /**
     * Sends a delivery again as soon as possible with a fresh attempt budget:
     * dead-lettered ones, delivered ones (redeliver) or pending ones (now).
     */
    async retryDelivery(id: string): Promise<WebhookDelivery> {
      admin()
      IdSchema.parse(id)
      return transact(ctx, async (repos) => {
        const delivery = await repos.webhookDeliveries.get(id)
        if (!delivery) throw new NotFoundError("Webhook delivery", id)
        const ts = now()
        const updated = await repos.webhookDeliveries.update(id, {
          status: "pending",
          attempts: 0,
          nextAttemptAt: ts,
          deliveredAt: null,
          updatedAt: ts,
        })
        if (!updated) throw new NotFoundError("Webhook delivery", id)
        await audit(repos, {
          action: "webhook.delivery_retried",
          targetId: delivery.webhookId,
          oldValue: { deliveryId: id, status: delivery.status },
          newValue: { deliveryId: id, status: "pending" },
          at: ts,
        })
        return updated
      })
    },
  }
  return service
}

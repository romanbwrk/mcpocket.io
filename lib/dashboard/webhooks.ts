import {
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENT_TYPES,
  type WebhookDeliveryStatus,
  type WebhookEventType,
} from "@mcpocket/core/domain/schemas"

/**
 * Client-safe helpers for the webhooks page (ticket 17): URL state of the
 * delivery log and form → service input conversion (the service validates
 * everything again).
 */

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  "item.created": "Item created",
  "item.updated": "Item updated (incl. heartbeats)",
  "item.status_changed": "Status changed (claim, complete, fail, retry…)",
  "item.deleted": "Item deleted",
}

export type WebhooksQuery = {
  webhook: string | null
  status: WebhookDeliveryStatus | null
}

const first = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v

/** Lenient: unknown values are ignored. */
export function parseWebhooksQuery(
  raw: Record<string, string | string[] | undefined>
): WebhooksQuery {
  const webhook = first(raw.webhook)
  const status = first(raw.status)
  return {
    webhook: webhook && /^[0-9a-f-]{36}$/i.test(webhook) ? webhook : null,
    status: (WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(
      status ?? ""
    )
      ? (status as WebhookDeliveryStatus)
      : null,
  }
}

export function webhooksHref(
  query: WebhooksQuery,
  patch: Partial<WebhooksQuery> = {}
): string {
  const next = { ...query, ...patch }
  const params = new URLSearchParams()
  if (next.webhook) params.set("webhook", next.webhook)
  if (next.status) params.set("status", next.status)
  const search = params.toString()
  return search ? `/dashboard/webhooks?${search}` : "/dashboard/webhooks"
}

export type WebhookFormFields = {
  name: string
  url: string
  /** Empty = all event types. */
  eventTypes: WebhookEventType[]
  /** `""`: everywhere; `folder:<id>` or `tube:<id>`. */
  scope: string
  enabled: boolean
}

export function webhookScopeValue(webhook: {
  folderId: string | null
  tubeId: string | null
}): string {
  if (webhook.tubeId) return `tube:${webhook.tubeId}`
  if (webhook.folderId) return `folder:${webhook.folderId}`
  return ""
}

/** Form fields → create / update input. */
export function webhookFormInput(fields: WebhookFormFields) {
  const [kind, id] = fields.scope.split(":", 2)
  const eventTypes =
    fields.eventTypes.length === WEBHOOK_EVENT_TYPES.length
      ? []
      : WEBHOOK_EVENT_TYPES.filter((t) => fields.eventTypes.includes(t))
  return {
    name: fields.name.trim(),
    url: fields.url.trim(),
    eventTypes,
    folderId: kind === "folder" && id ? id : null,
    tubeId: kind === "tube" && id ? id : null,
    enabled: fields.enabled,
  }
}

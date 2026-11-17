import { WebhookDeliveries } from "@/components/dashboard/webhook-deliveries"
import { WebhooksPanel } from "@/components/dashboard/webhooks-panel"
import { getUserServices } from "@/lib/auth/server"
import { parseWebhooksQuery } from "@/lib/dashboard/webhooks"
import { webhookConfigFromEnv } from "@mcpocket/core/services/webhook-dispatcher"

export const metadata = { title: "Webhooks" }

const DELIVERY_LIMIT = 50

/**
 * Webhooks (ticket 17): subscriptions (URL, event types, folder/tube scope,
 * signing secret) and the delivery log / outbox with per-attempt details and
 * manual retry. Everything goes through `services.webhooks` (admin, audited).
 */
export default async function WebhooksPage({
  searchParams,
}: PageProps<"/dashboard/webhooks">) {
  const query = parseWebhooksQuery(await searchParams)
  const services = await getUserServices()
  const [webhooks, deliveries] = await Promise.all([
    services.webhooks.list(),
    services.webhooks.deliveries({
      webhookId: query.webhook ?? undefined,
      status: query.status ?? undefined,
      limit: DELIVERY_LIMIT,
    }),
  ])
  const config = webhookConfigFromEnv()

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Webhooks</h1>
        <p className="text-xs text-muted-foreground">
          Item changes are written to an outbox in the same transaction as the
          change and POSTed to each matching subscription, signed with{" "}
          <code>X-MCPocket-Signature: t=…,v1=HMAC-SHA256(secret, t.body)</code>.
          Failed deliveries are retried with exponential backoff (up to{" "}
          {config.maxAttempts} attempts), then dead-lettered.
          {!config.enabled && (
            <strong className="text-destructive">
              {" "}
              The dispatcher is disabled (MCPOCKET_WEBHOOKS_ENABLED=false):
              deliveries queue up but are not sent.
            </strong>
          )}
        </p>
      </div>
      <WebhooksPanel webhooks={webhooks} query={query} />
      <WebhookDeliveries
        deliveries={deliveries.data}
        total={deliveries.page.total}
        webhooks={webhooks.map((w) => ({ id: w.id, name: w.name }))}
        query={query}
      />
    </div>
  )
}

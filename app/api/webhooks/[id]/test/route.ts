import { apiHandler, created } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** POST /api/webhooks/{id}/test → 201 { data: WebhookDelivery } — queues a `webhook.ping` delivery. */
export const POST = apiHandler<Params>(async ({ services, params }) =>
  created({ data: await services.webhooks.test(params.id) })
)

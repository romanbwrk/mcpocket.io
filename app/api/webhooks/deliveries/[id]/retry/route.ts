import { apiHandler } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** POST /api/webhooks/deliveries/{id}/retry → { data } — re-queues it now with a fresh attempt budget (dead, delivered or pending). */
export const POST = apiHandler<Params>(async ({ services, params }) => ({
  data: await services.webhooks.retryDelivery(params.id),
}))

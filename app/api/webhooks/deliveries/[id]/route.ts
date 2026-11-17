import { apiHandler } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** GET /api/webhooks/deliveries/{id} — payload, status and attempt log (admin) */
export const GET = apiHandler<Params>(async ({ services, params }) => ({
  data: await services.webhooks.delivery(params.id),
}))

import { apiHandler, queryObject } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** GET /api/webhooks/{id}/deliveries?status=pending,dead&offset&limit — newest first (admin) */
export const GET = apiHandler<Params>(async ({ services, params, url }) =>
  services.webhooks.deliveries({ ...queryObject(url), webhookId: params.id })
)

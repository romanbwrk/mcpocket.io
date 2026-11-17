import { apiHandler, queryObject } from "@mcpocket/core/api/handler"

/** GET /api/webhooks/deliveries?webhookId&status=pending,delivered,dead&offset&limit — outbox / delivery log, newest first (admin) */
export const GET = apiHandler(async ({ services, url }) =>
  services.webhooks.deliveries(queryObject(url))
)

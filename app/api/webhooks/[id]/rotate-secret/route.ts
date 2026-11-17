import { apiHandler } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** POST /api/webhooks/{id}/rotate-secret → { data: Webhook, secret } — new signing secret, shown once. */
export const POST = apiHandler<Params>(async ({ services, params }) => {
  const { webhook, secret } = await services.webhooks.rotateSecret(params.id)
  return { data: webhook, secret }
})

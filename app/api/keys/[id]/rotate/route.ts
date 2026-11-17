import { apiHandler } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** POST /api/keys/{id}/rotate → { data: ApiKey, secret } — new secret, shown once; the old one stops working. */
export const POST = apiHandler<Params>(async ({ services, params }) => {
  const { key, secret } = await services.apiKeys.rotate(params.id)
  return { data: key, secret }
})

import { apiHandler } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** POST /api/keys/{id}/revoke → { data: ApiKey } — the key stops authenticating (rotate re-activates it). */
export const POST = apiHandler<Params>(async ({ services, params }) => ({
  data: await services.apiKeys.revoke(params.id),
}))

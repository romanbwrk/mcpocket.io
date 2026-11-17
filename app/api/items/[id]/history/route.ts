import { apiHandler, queryObject } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** GET /api/items/{id}/history?offset=&limit= — audit events, newest first */
export const GET = apiHandler<Params>(({ services, params, url }) =>
  services.items.history(params.id, queryObject(url))
)

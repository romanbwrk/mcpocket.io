import { apiHandler, queryObject } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** GET /api/agents/{id}/items?status=processing,failed&offset=&limit= */
export const GET = apiHandler<Params>(({ services, params, url }) =>
  services.processing.agentItems(params.id, queryObject(url))
)

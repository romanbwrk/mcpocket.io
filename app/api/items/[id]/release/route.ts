import { apiHandler, readJsonBody } from "@mcpocket/core/api/handler"

type Params = { id: string }

/**
 * POST /api/items/{id}/release { reason? } — returns the item to `pending`
 * — lease owner only (`X-Agent-Id`): other agent → 403, expired lease or
 * item not processing → 409.
 */
export const POST = apiHandler<Params>(
  async ({ services, params, request }) => ({
    data: await services.processing.release(
      params.id,
      await readJsonBody(request)
    ),
  })
)

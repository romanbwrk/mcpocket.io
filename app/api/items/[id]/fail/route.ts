import { apiHandler, readJsonBody } from "@mcpocket/core/api/handler"

type Params = { id: string }

/**
 * POST /api/items/{id}/fail { error: string | { message, code?, details? } } — sets `failed`, `lastError`
 * — lease owner only (`X-Agent-Id`): other agent → 403, expired lease or
 * item not processing → 409.
 */
export const POST = apiHandler<Params>(
  async ({ services, params, request }) => ({
    data: await services.processing.fail(
      params.id,
      await readJsonBody(request)
    ),
  })
)

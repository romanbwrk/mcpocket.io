import { apiHandler, readJsonBody } from "@mcpocket/core/api/handler"
import { MAX_BULK_BODY_BYTES } from "@mcpocket/core/services"

type Params = { id: string }

/**
 * POST /api/tubes/{id}/items/bulk { items: PushItemInput[] } (≤ 500 entries,
 * ≤ 5 MiB body) → 200 { results: [{ index, ok, created?, data? , error? }],
 * summary: { total, succeeded, failed, created } }. One transaction, one
 * persist; each entry follows the single-push rules.
 */
export const POST = apiHandler<Params>(async ({ services, params, request }) =>
  services.items.bulkPush(
    params.id,
    await readJsonBody(request, { maxBytes: MAX_BULK_BODY_BYTES })
  )
)

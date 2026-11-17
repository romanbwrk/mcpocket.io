import { apiHandler, readJsonBody } from "@mcpocket/core/api/handler"
import { MAX_BULK_BODY_BYTES } from "@mcpocket/core/services"

/**
 * PATCH /api/items/bulk { items: [{ id, ...changes }] } or { ids, patch }
 * (≤ 500 entries, ≤ 5 MiB body) → 200 { results: [{ index, ok, id?, data?,
 * error? }], summary: { total, succeeded, failed } }. One transaction, one
 * persist; each entry follows the single-update (PATCH /api/items/{id}) rules.
 */
export const PATCH = apiHandler(async ({ services, request }) =>
  services.items.bulkUpdate(
    await readJsonBody(request, { maxBytes: MAX_BULK_BODY_BYTES })
  )
)

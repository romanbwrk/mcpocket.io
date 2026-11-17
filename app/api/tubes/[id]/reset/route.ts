import { apiHandler, readJsonBody } from "@mcpocket/core/api/handler"

type Params = { id: string }

/**
 * POST /api/tubes/{id}/reset { status?, assignedAgent?, createdFrom?,
 * createdTo?, priority?, priorityMin?, priorityMax?, tags?, payload? }
 * → 200 { data: { total, matched, requeued } }. Puts every non-deleted item
 * of the tube matching the (optional) item filters back to a fresh `pending`
 * state (active leases are revoked; attempts, result and last error cleared).
 * No body / `{}` = every item; `{ "status": "failed" }` = failed items only.
 * Needs `items:manage`.
 */
export const POST = apiHandler<Params>(
  async ({ services, params, request }) => ({
    data: await services.items.requeueAll(
      params.id,
      await readJsonBody(request)
    ),
  })
)

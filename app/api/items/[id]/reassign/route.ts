import { apiHandler, readJsonBody } from "@mcpocket/core/api/handler"

type Params = { id: string }

/**
 * POST /api/items/{id}/reassign { agentId: string | null } — sets the
 * item's `assignedAgent` (a processing item's lease moves to the new agent;
 * unassigning a processing item → 409). Deleted item → 409. Writes a
 * `reassigned` history event.
 */
export const POST = apiHandler<Params>(
  async ({ services, params, request }) => ({
    data: await services.items.reassign(params.id, await readJsonBody(request)),
  })
)

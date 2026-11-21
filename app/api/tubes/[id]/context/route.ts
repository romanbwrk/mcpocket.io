import { apiHandler } from "@mcpocket/core/api/handler"

type Params = { id: string }

/**
 * GET /api/tubes/{id}/context → { data: { tubeId, name, instructions,
 * memory: [{ id, text, createdAt, updatedAt }] } }. Set instructions with
 * PATCH /api/tubes/{id} { instructions }.
 */
export const GET = apiHandler<Params>(async ({ services, params }) => ({
  data: await services.tubes.context(params.id),
}))

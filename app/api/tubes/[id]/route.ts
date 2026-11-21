import { apiHandler, noContent, readJsonBody } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** GET /api/tubes/{id} */
export const GET = apiHandler<Params>(async ({ services, params }) => ({
  data: await services.tubes.get(params.id),
}))

/**
 * PATCH /api/tubes/{id}
 * { name?, description?: string|null, enabled?, schemaDefinition?: object|null,
 *   instructions?: string|null, folderId? }
 * — moving = folderId
 */
export const PATCH = apiHandler<Params>(
  async ({ services, params, request }) => ({
    data: await services.tubes.update(params.id, await readJsonBody(request)),
  })
)

/** DELETE /api/tubes/{id} — only tubes without (non-deleted) items (409 otherwise) */
export const DELETE = apiHandler<Params>(async ({ services, params }) => {
  await services.tubes.delete(params.id)
  return noContent()
})

import { apiHandler, noContent, readJsonBody } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** GET /api/folders/{id} */
export const GET = apiHandler<Params>(async ({ services, params }) => ({
  data: await services.folders.get(params.id),
}))

/** PATCH /api/folders/{id} { name?, description?: string|null, parentId?: id|null } — moving = parentId */
export const PATCH = apiHandler<Params>(
  async ({ services, params, request }) => ({
    data: await services.folders.update(params.id, await readJsonBody(request)),
  })
)

/** DELETE /api/folders/{id} — only empty folders (409 otherwise) */
export const DELETE = apiHandler<Params>(async ({ services, params }) => {
  await services.folders.delete(params.id)
  return noContent()
})

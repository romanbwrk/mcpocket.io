import { apiHandler, noContent, readJsonBody } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** GET /api/items/{id} — soft-deleted items are returned too (`deletedAt` set) */
export const GET = apiHandler<Params>(async ({ services, params }) => ({
  data: await services.items.get(params.id),
}))

/**
 * PATCH /api/items/{id} { payload?, metadata?, tags?, priority?, status? }
 * — invalid status transitions → 409; deleted items → 409
 */
export const PATCH = apiHandler<Params>(
  async ({ services, params, request }) => ({
    data: await services.items.update(params.id, await readJsonBody(request)),
  })
)

/** DELETE /api/items/{id} — soft delete (sets `deletedAt`) */
export const DELETE = apiHandler<Params>(async ({ services, params }) => {
  await services.items.delete(params.id)
  return noContent()
})

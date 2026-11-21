import { apiHandler, noContent, readJsonBody } from "@mcpocket/core/api/handler"

type Params = { id: string; memoryId: string }

/** PATCH /api/tubes/{id}/memory/{memoryId} { text } → { data: TubeMemoryBlock }. Needs `items:process`. */
export const PATCH = apiHandler<Params>(
  async ({ services, params, request }) => ({
    data: await services.tubes.updateMemory(
      params.id,
      params.memoryId,
      await readJsonBody(request)
    ),
  })
)

/** DELETE /api/tubes/{id}/memory/{memoryId} → 204. Needs `items:process`. */
export const DELETE = apiHandler<Params>(async ({ services, params }) => {
  await services.tubes.deleteMemory(params.id, params.memoryId)
  return noContent()
})

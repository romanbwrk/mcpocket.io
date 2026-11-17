import { apiHandler, noContent, readJsonBody } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** GET /api/keys/{id} (admin) */
export const GET = apiHandler<Params>(async ({ services, params }) => ({
  data: await services.apiKeys.get(params.id),
}))

/** PATCH /api/keys/{id} { description?, role?, scope?, agentId?, rateLimitPerMinute? } (admin; env keys → 409) */
export const PATCH = apiHandler<Params>(
  async ({ services, params, request }) => ({
    data: await services.apiKeys.update(params.id, await readJsonBody(request)),
  })
)

/** DELETE /api/keys/{id} (admin; env keys → 409) */
export const DELETE = apiHandler<Params>(async ({ services, params }) => {
  await services.apiKeys.delete(params.id)
  return noContent()
})

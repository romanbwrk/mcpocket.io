import { apiHandler, noContent, readJsonBody } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** GET /api/webhooks/{id} (admin) */
export const GET = apiHandler<Params>(async ({ services, params }) => ({
  data: await services.webhooks.get(params.id),
}))

/** PATCH /api/webhooks/{id} { name?, url?, eventTypes?, folderId?, tubeId?, enabled? } (admin; null clears scope) */
export const PATCH = apiHandler<Params>(
  async ({ services, params, request }) => ({
    data: await services.webhooks.update(
      params.id,
      await readJsonBody(request)
    ),
  })
)

/** DELETE /api/webhooks/{id} — also removes its outbox / delivery log (admin) */
export const DELETE = apiHandler<Params>(async ({ services, params }) => {
  await services.webhooks.delete(params.id)
  return noContent()
})

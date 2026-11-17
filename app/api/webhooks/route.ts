import { apiHandler, created, readJsonBody } from "@mcpocket/core/api/handler"

/** GET /api/webhooks — every subscription with delivery counts, never secrets. Admin only. */
export const GET = apiHandler(async ({ services }) => ({
  data: await services.webhooks.list(),
}))

/**
 * POST /api/webhooks { name, url, eventTypes?: ItemEventType[], folderId? | tubeId?,
 * enabled? } → 201 { data: Webhook, secret } — the signing secret is shown
 * only in this response. Admin only.
 */
export const POST = apiHandler(async ({ services, request }) => {
  const { webhook, secret } = await services.webhooks.create(
    await readJsonBody(request)
  )
  return created({ data: webhook, secret })
})

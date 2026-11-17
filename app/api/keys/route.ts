import { apiHandler, created, readJsonBody } from "@mcpocket/core/api/handler"

/** GET /api/keys — every API key (env + managed), never secrets. Admin only. */
export const GET = apiHandler(async ({ services }) => ({
  data: await services.apiKeys.list(),
}))

/**
 * POST /api/keys { id, role, description?, scope?: {folderIds, tubeIds} | null,
 * agentId?, rateLimitPerMinute? } → 201 { data: ApiKey, secret } — the secret
 * is shown only in this response. Admin only.
 */
export const POST = apiHandler(async ({ services, request }) => {
  const { key, secret } = await services.apiKeys.create(
    await readJsonBody(request)
  )
  return created({ data: key, secret })
})

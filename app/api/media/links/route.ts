import { apiHandler, readJsonBody } from "@mcpocket/core/api/handler"

/**
 * POST /api/media/links { url | urls, expiresInSeconds? } → temporary
 * signed links for stored media (same as the MCP tool `create_media_link`).
 * Needs `read`.
 */
export const POST = apiHandler(async ({ services, request }) =>
  services.media.createLinks(
    await readJsonBody(request, { maxBytes: 256 * 1024 })
  )
)

import { apiHandler } from "@mcpocket/core/api/handler"

/**
 * GET /api/media/usage?key=<object key> → { data: { key, url, items: [{ id,
 * tubeId, tubeName, status, fields }] } } — non-deleted items whose payload,
 * metadata or result reference the object.
 */
export const GET = apiHandler(async ({ services, url }) => ({
  data: await services.media.usage(url.searchParams.get("key") ?? ""),
}))

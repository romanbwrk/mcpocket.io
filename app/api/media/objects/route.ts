import { apiHandler, queryObject } from "@mcpocket/core/api/handler"

/**
 * GET /api/media/objects?kind=image|video|audio|document|other&usage=used|unused&offset=&limit=
 * → { data: [{ key, url, size, lastModified, contentType, kind, usedBy }],
 * page, summary: { count, bytes, unused, byKind }, truncated, location }.
 * Newest first. 409 when media storage is not configured.
 */
export const GET = apiHandler(({ services, url }) =>
  services.media.list(queryObject(url))
)

/**
 * DELETE /api/media/objects?key=<object key> → { data: { key } }. Needs
 * `items:manage`. Items still referencing the URL keep a broken link —
 * check `GET /api/media/usage?key=` first.
 */
export const DELETE = apiHandler(async ({ services, url }) => ({
  data: await services.media.delete(url.searchParams.get("key") ?? ""),
}))

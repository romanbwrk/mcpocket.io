import { apiHandler, created } from "@mcpocket/core/api/handler"
import { readMediaUpload } from "@mcpocket/core/api/media-upload"

/**
 * GET /api/media → { data: { enabled, maxBytes?, allowedTypes? } }
 */
export const GET = apiHandler(({ services }) => ({
  data: services.media.status(),
}))

/**
 * POST /api/media — upload one file to S3 → 201 { data: { url, key,
 * contentType, size, sha256, filename? } }. Put `data.url` into item
 * payloads. Two body forms:
 *
 * - raw bytes with the file's `Content-Type` (`?filename=` optional)
 * - `multipart/form-data` with a `file` field
 *
 * Needs `items:push`. 409 when media storage is not configured, 413 above
 * `MCPOCKET_MEDIA_MAX_BYTES`, 400 for a type outside
 * `MCPOCKET_MEDIA_ALLOWED_TYPES`.
 */
export const POST = apiHandler(async ({ services, request }) => {
  const file = await readMediaUpload(request, services.media.status())
  return created({ data: await services.media.upload(file) })
})

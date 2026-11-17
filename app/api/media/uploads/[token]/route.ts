import { enforceRateLimit } from "@mcpocket/core/api/auth"
import { toErrorResponse } from "@mcpocket/core/api/errors"
import { readMediaUpload } from "@mcpocket/core/api/media-upload"
import { withRateLimitHeaders } from "@mcpocket/core/api/rate-limit"
import type { RateLimitInfo } from "@mcpocket/core/domain/errors"
import {
  authorizeUpload,
  publicUrlFor,
  uploadTokenWorkspace,
  uploadWithToken,
  workspaceContext,
} from "@mcpocket/core/services"

type Params = { params: Promise<{ token: string }> }

/**
 * PUT (or POST) /api/media/uploads/{token} — upload one file through a
 * signed link from the MCP tool `create_media_upload`. No API key: the
 * token is the credential (short-lived, bound to the key that created it,
 * which is re-checked and rate-limited here). Same body forms and limits as
 * `POST /api/media`.
 * → 201 { data: { url, key, contentType, size, sha256, filename? } }
 */
async function upload(request: Request, { params }: Params) {
  let rateLimit: RateLimitInfo | null = null
  try {
    const { token } = await params
    // Multi-workspace mode: the workspace the link was created in.
    const ctx = await workspaceContext(uploadTokenWorkspace(token), {
      publicUrl: publicUrlFor(request),
    })
    const auth = await authorizeUpload(ctx, token)
    rateLimit = enforceRateLimit({
      actor: { kind: "api_key", id: auth.keyId },
      keyId: auth.keyId,
      rateLimitPerMinute: auth.rateLimitPerMinute,
    })
    const status = ctx.media
      ? { enabled: true as const, ...ctx.media.limits }
      : { enabled: false as const }
    const file = await readMediaUpload(request, status)
    const data = await uploadWithToken(ctx, auth, file)
    return withRateLimitHeaders(
      Response.json({ data }, { status: 201 }),
      rateLimit
    )
  } catch (error) {
    return withRateLimitHeaders(toErrorResponse(error), rateLimit)
  }
}

export const PUT = upload
export const POST = upload

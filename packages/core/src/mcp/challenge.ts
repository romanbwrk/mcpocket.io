import { toErrorResponse } from "../api/errors"
import { oauthChallenge, oauthConfigFromEnv } from "../auth/oauth"
import { UnauthorizedError } from "../domain/errors"
import { publicUrlFor } from "../services/context"

/**
 * Error response of an MCP endpoint. A 401 also carries
 * `WWW-Authenticate: Bearer resource_metadata="…"` when OAuth is
 * configured, so OAuth clients (ChatGPT) can discover the authorization
 * server and start sign-in (RFC 9728).
 */
export function mcpErrorResponse(error: unknown, request: Request): Response {
  const response = toErrorResponse(error)
  if (!(error instanceof UnauthorizedError) || !oauthConfigFromEnv()) {
    return response
  }
  const presented =
    request.headers.has("authorization") || request.headers.has("x-api-key")
  response.headers.set(
    "WWW-Authenticate",
    oauthChallenge(
      publicUrlFor(request),
      new URL(request.url).pathname,
      presented
    )
  )
  return response
}

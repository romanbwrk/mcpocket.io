import {
  oauthConfigFromEnv,
  protectedResourceMetadata,
} from "@mcpocket/core/auth/oauth"
import { publicUrlFor } from "@mcpocket/core/services"

type Params = { params: Promise<{ path?: string[] }> }

/** Endpoints that are OAuth protected resources (the MCP transports). */
const MCP_PATH = /^\/api\/mcp(\/(tubes|folders)\/[0-9a-f-]{36}|\/sse)?$/i

/**
 * GET /.well-known/oauth-protected-resource[/<resource path>] — OAuth
 * protected resource metadata (RFC 9728) for the MCP endpoints, so OAuth
 * clients such as ChatGPT find the authorization server. The bare path
 * describes `/api/mcp`; the path form describes that endpoint (e.g.
 * `/.well-known/oauth-protected-resource/api/mcp/tubes/<id>`). 404 when
 * OAuth is not configured (MCPOCKET_OAUTH_ISSUER).
 */
export async function GET(request: Request, { params }: Params) {
  const config = oauthConfigFromEnv()
  const path = "/" + ((await params).path ?? ["api", "mcp"]).join("/")
  if (!config || !MCP_PATH.test(path)) {
    return Response.json(
      { error: { code: "not_found", message: "Not found" } },
      { status: 404 }
    )
  }
  return Response.json(
    protectedResourceMetadata(`${publicUrlFor(request)}${path}`, config),
    {
      headers: {
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    }
  )
}

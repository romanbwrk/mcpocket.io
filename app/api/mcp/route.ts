import { handleStreamableHttp } from "@mcpocket/core/mcp/http"

/**
 * MCP Streamable HTTP transport (stateless, JSON responses). Requires the
 * API key; see README "Connecting MCP clients". Only POST: there are no
 * sessions to DELETE and no server-initiated stream, so GET / DELETE get
 * Next's automatic 405 (which MCP clients treat as "no standalone stream").
 */
export const POST = (request: Request) => handleStreamableHttp(request)

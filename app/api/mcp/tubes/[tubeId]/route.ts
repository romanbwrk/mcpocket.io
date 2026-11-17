import { handleStreamableHttp } from "@mcpocket/core/mcp/http"

/**
 * Tube-scoped MCP Streamable HTTP endpoint: like `/api/mcp`, but the session
 * only sees this tube and `tubeId` arguments default to it
 * (lib/mcp/connection-scope.ts). 404 when the API key cannot reach the tube.
 */
export const POST = async (
  request: Request,
  { params }: RouteContext<"/api/mcp/tubes/[tubeId]">
) =>
  handleStreamableHttp(request, {
    scope: { kind: "tube", id: (await params).tubeId },
  })

import { handleStreamableHttp } from "@mcpocket/core/mcp/http"

/**
 * Folder-scoped MCP Streamable HTTP endpoint: like `/api/mcp`, but the
 * session only sees this folder's subtree, and new folders / tubes default
 * into it (lib/mcp/connection-scope.ts). 404 / 403 when the API key cannot
 * fully access the folder.
 */
export const POST = async (
  request: Request,
  { params }: RouteContext<"/api/mcp/folders/[folderId]">
) =>
  handleStreamableHttp(request, {
    scope: { kind: "folder", id: (await params).folderId },
  })

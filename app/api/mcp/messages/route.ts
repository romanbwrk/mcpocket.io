import { postLegacySseMessage } from "@mcpocket/core/mcp/sse"

/** Legacy MCP HTTP+SSE transport: client → server messages for a session. */
export const POST = (request: Request) => postLegacySseMessage(request)

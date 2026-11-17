import { openLegacySseSession } from "@mcpocket/core/mcp/sse"

/** Legacy MCP HTTP+SSE transport: opens the event stream (API key required). */
export const GET = (request: Request) => openLegacySseSession(request)

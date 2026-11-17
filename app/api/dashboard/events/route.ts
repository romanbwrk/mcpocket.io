import { getSession, userActor } from "@/lib/auth/server"
import { getEventBus } from "@mcpocket/core/events/bus"
import { createEventStreamResponse } from "@mcpocket/core/events/sse"
import { parseEventScope } from "@mcpocket/core/events/types"

/**
 * GET /api/dashboard/events[?tubeId=<id>|?itemId=<id>] — Server-Sent Events
 * stream of domain events for the dashboard. Auth = the dashboard session
 * cookie (never an API key: this is consumed by the browser's EventSource).
 * No scope → global; structural (folder/tube) events reach every scope.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSession()
  if (!session) {
    return Response.json(
      {
        error: { code: "unauthorized", message: "Dashboard session required" },
      },
      { status: 401 }
    )
  }
  const scope = parseEventScope(new URL(request.url).searchParams)
  if (!scope) {
    return Response.json(
      {
        error: { code: "validation_error", message: "Invalid tubeId / itemId" },
      },
      { status: 400 }
    )
  }
  return createEventStreamResponse({
    bus: getEventBus(),
    scope,
    // Multi-workspace mode: only the session's workspace.
    workspace: userActor(session).workspace,
    signal: request.signal,
  })
}

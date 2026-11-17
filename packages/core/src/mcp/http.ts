import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"

import { authorizeRequest } from "../api/auth"
import { mcpErrorResponse } from "./challenge"
import { withRateLimitHeaders } from "../api/rate-limit"
import type { Actor } from "../domain/actor"
import type { RateLimitInfo } from "../domain/errors"
import { getServices, publicUrlFor } from "../services"

import { createMcpServer, type CreateMcpServerOptions } from "./server"
import { resolveConnectionScope, type ScopeTarget } from "./connection-scope"

export type StreamableHttpOptions = Pick<CreateMcpServerOptions, "tools"> & {
  /** Bind the connection to one tube / folder (lib/mcp/connection-scope.ts). */
  scope?: ScopeTarget
}

/**
 * MCP Streamable HTTP endpoint (`/api/mcp`), stateless: every HTTP request
 * is authenticated with the API key (`Authorization: Bearer` / `X-API-Key`,
 * optional `X-Agent-Id`), counted against the key's rate limit (429 +
 * `RateLimit-*` headers), gets a fresh server bound to that actor and is
 * answered with plain JSON (no server-initiated stream: the route only
 * exports POST, so GET → 405).
 * Stateless mode suits the single-process JSON storage and dev hot reloads;
 * there is no session to lose.
 */
export async function handleStreamableHttp(
  request: Request,
  { scope: target, ...options }: StreamableHttpOptions = {}
): Promise<Response> {
  let actor: Actor
  let rateLimit: RateLimitInfo | null
  let scoped: Pick<CreateMcpServerOptions, "tools" | "instructions"> = {}
  try {
    const authorized = await authorizeRequest(request)
    actor = authorized.principal.actor
    rateLimit = authorized.rateLimit
    if (target) {
      const scope = await resolveConnectionScope(actor, target)
      actor = scope.actor
      scoped = { tools: scope.tools, instructions: scope.instructions }
    }
  } catch (error) {
    return mcpErrorResponse(error, request)
  }
  const server = createMcpServer({
    ...scoped,
    ...options,
    services: () => getServices(actor, { publicUrl: publicUrlFor(request) }),
  })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return withRateLimitHeaders(
      await transport.handleRequest(request),
      rateLimit
    )
  } finally {
    await server.close()
  }
}

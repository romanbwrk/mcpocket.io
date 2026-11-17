import { randomUUID } from "node:crypto"

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
  type MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js"

import { API_KEY_QUERY_PARAM, authorizeRequest } from "../api/auth"
import { mcpErrorResponse } from "./challenge"
import { withRateLimitHeaders } from "../api/rate-limit"
import { readJsonBody } from "../api/handler"
import type { Actor } from "../domain/actor"
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../domain/errors"
import { getServices, publicUrlFor } from "../services"

import { createMcpServer, type CreateMcpServerOptions } from "./server"
import {
  narrowAccess,
  resolveConnectionScope,
  scopeTargetFromSearch,
  type ScopeTarget,
} from "./connection-scope"

/**
 * Legacy MCP "HTTP+SSE" transport (protocol 2024-11-05) for older clients:
 * `GET /api/mcp/sse` opens an event stream whose first `endpoint` event
 * tells the client where to POST its JSON-RPC messages
 * (`/api/mcp/messages?sessionId=…`); responses come back on the stream.
 *
 * The SDK's `SSEServerTransport` needs Node `ServerResponse`, which Next
 * route handlers don't have, so this is a Web-standard equivalent. Sessions
 * live in process memory (v1 is single-process) and are bound to the actor
 * that opened them; POSTs must use the same API key.
 */
export const LEGACY_SSE_PATH = "/api/mcp/sse"
export const LEGACY_MESSAGES_PATH = "/api/mcp/messages"
const KEEP_ALIVE_MS = 15_000

export class WebSseServerTransport implements Transport {
  readonly sessionId = randomUUID()
  readonly stream: ReadableStream<Uint8Array>
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void

  private controller!: ReadableStreamDefaultController<Uint8Array>
  private readonly encoder = new TextEncoder()
  private keepAlive?: ReturnType<typeof setInterval>
  private closed = false

  /** `extraQuery`: appended to the announced endpoint (e.g. `api_key=…`). */
  constructor(
    private readonly messagesPath: string,
    private readonly extraQuery = ""
  ) {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller
      },
      cancel: () => this.close(), // client disconnected
    })
  }

  private write(chunk: string) {
    if (this.closed) throw new Error("SSE stream is closed")
    this.controller.enqueue(this.encoder.encode(chunk))
  }

  async start(): Promise<void> {
    const endpoint = `${this.messagesPath}?sessionId=${this.sessionId}${
      this.extraQuery ? `&${this.extraQuery}` : ""
    }`
    this.write(`event: endpoint\ndata: ${endpoint}\n\n`)
    this.keepAlive = setInterval(() => {
      try {
        this.write(": keep-alive\n\n")
      } catch {
        void this.close()
      }
    }, KEEP_ALIVE_MS)
  }

  async send(message: JSONRPCMessage) {
    this.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
  }

  /** Delivers a client message received via POST. */
  receive(message: JSONRPCMessage, extra?: MessageExtraInfo) {
    if (this.closed) throw new NotFoundError("MCP session", this.sessionId)
    this.onmessage?.(message, extra)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearInterval(this.keepAlive)
    try {
      this.controller.close()
    } catch {
      // already closed / cancelled
    }
    this.onclose?.()
  }
}

type LegacySession = {
  transport: WebSseServerTransport
  keyId: string
  /** Identity fixed at open; `access` refreshed on every message (role/scope changes apply). */
  actor: Actor
  /** Tube / folder the session is bound to (`?tubeId=` / `?folderId=`), if any. */
  target?: ScopeTarget
}

const globalForSse = globalThis as typeof globalThis & {
  __mcpocketSseSessions?: Map<string, LegacySession>
}
/** On globalThis so every route bundle (and dev hot reloads) share it. */
const sessions = (globalForSse.__mcpocketSseSessions ??= new Map())

export const legacySseSessionCount = () => sessions.size

/**
 * `GET /api/mcp/sse[?tubeId=…|?folderId=…]` — opens a legacy SSE session for
 * the authenticated actor, optionally bound to one tube or folder
 * (lib/mcp/connection-scope.ts).
 */
export async function openLegacySseSession(
  request: Request,
  options: Pick<CreateMcpServerOptions, "tools"> = {}
): Promise<Response> {
  let session: LegacySession
  let scoped: Pick<CreateMcpServerOptions, "tools" | "instructions"> = {}
  try {
    const { principal } = await authorizeRequest(request)
    const search = new URL(request.url).searchParams
    const target = scopeTargetFromSearch(search)
    // A key passed as ?api_key= must reach the messages endpoint too.
    const key = search.get(API_KEY_QUERY_PARAM)
    session = {
      transport: new WebSseServerTransport(
        LEGACY_MESSAGES_PATH,
        key ? `${API_KEY_QUERY_PARAM}=${encodeURIComponent(key)}` : ""
      ),
      keyId: principal.keyId,
      actor: principal.actor,
    }
    if (target) {
      const scope = await resolveConnectionScope(principal.actor, target)
      session.actor = scope.actor
      session.target = scope.target
      scoped = { tools: scope.tools, instructions: scope.instructions }
    }
  } catch (error) {
    return mcpErrorResponse(error, request)
  }
  const { transport } = session
  const publicUrl = publicUrlFor(request)
  const server = createMcpServer({
    ...scoped,
    ...options,
    services: () => getServices(session.actor, { publicUrl }),
  })
  sessions.set(transport.sessionId, session)
  transport.onclose = () => sessions.delete(transport.sessionId)
  await server.connect(transport) // starts → sends the endpoint event
  request.signal?.addEventListener("abort", () => void server.close())

  return new Response(transport.stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  })
}

/** `POST /api/mcp/messages?sessionId=…` — a client → server JSON-RPC message. */
export async function postLegacySseMessage(
  request: Request
): Promise<Response> {
  try {
    const { principal, rateLimit } = await authorizeRequest(request)
    const sessionId = new URL(request.url).searchParams.get("sessionId") ?? ""
    const session = sessions.get(sessionId)
    if (!session) throw new NotFoundError("MCP session", sessionId)
    if (session.keyId !== principal.keyId) {
      throw new ForbiddenError("MCP session belongs to another API key")
    }
    // Same key: pick up role/scope changes made since the session opened.
    session.actor = {
      ...session.actor,
      access: session.target
        ? narrowAccess(principal.actor.access, session.target)
        : principal.actor.access,
    }
    const parsed = JSONRPCMessageSchema.safeParse(await readJsonBody(request))
    if (!parsed.success) {
      throw new ValidationError("Body is not a valid JSON-RPC message")
    }
    session.transport.receive(parsed.data, {
      requestInfo: {
        headers: Object.fromEntries(request.headers),
        url: new URL(request.url),
      },
    })
    return withRateLimitHeaders(
      new Response("Accepted", { status: 202 }),
      rateLimit
    )
  } catch (error) {
    return mcpErrorResponse(error, request)
  }
}

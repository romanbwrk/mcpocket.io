#!/usr/bin/env node
/**
 * MCPocket stdio entry point — a thin proxy, NOT a second server.
 *
 * v1 JSON storage is single-process, so this process never opens `data/`.
 * It relays raw JSON-RPC messages between stdio (the local agent, e.g.
 * Claude Desktop / Claude Code) and the running app's MCP Streamable HTTP
 * endpoint (`<MCPOCKET_URL>/api/mcp`), authenticating with an API key.
 * Proxying MCP (rather than calling REST) means stdio clients get exactly
 * the HTTP tool set, schemas and error semantics with no duplicated code.
 *
 * Env:
 *   MCPOCKET_URL       app base URL (default http://localhost:3000)
 *   MCPOCKET_API_KEY   API key secret (required; one of MCPOCKET_API_KEYS)
 *   MCPOCKET_AGENT_ID  optional agent id (sent as X-Agent-Id)
 *   MCPOCKET_TUBE_ID   optional: bind the session to one tube
 *                      (proxies to <MCPOCKET_URL>/api/mcp/tubes/<id>)
 *   MCPOCKET_FOLDER_ID optional: bind the session to one folder subtree
 *                      (proxies to <MCPOCKET_URL>/api/mcp/folders/<id>)
 *
 * Logs go to stderr only: stdout carries the MCP protocol.
 */
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

const log = (...args) => console.error("[mcpocket-stdio]", ...args)

const baseUrl = process.env.MCPOCKET_URL?.trim() || "http://localhost:3000"
const apiKey = process.env.MCPOCKET_API_KEY?.trim()
const agentId = process.env.MCPOCKET_AGENT_ID?.trim()
const tubeId = process.env.MCPOCKET_TUBE_ID?.trim()
const folderId = process.env.MCPOCKET_FOLDER_ID?.trim()

if (!apiKey) {
  log(
    "MCPOCKET_API_KEY is required (a secret from the app's MCPOCKET_API_KEYS)"
  )
  process.exit(1)
}

if (tubeId && folderId) {
  log("Set either MCPOCKET_TUBE_ID or MCPOCKET_FOLDER_ID, not both")
  process.exit(1)
}

const endpoint = new URL(
  tubeId
    ? `api/mcp/tubes/${encodeURIComponent(tubeId)}`
    : folderId
      ? `api/mcp/folders/${encodeURIComponent(folderId)}`
      : "api/mcp",
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
)
const headers = { authorization: `Bearer ${apiKey}` }
if (agentId) headers["x-agent-id"] = agentId

const upstream = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers },
})
const local = new StdioServerTransport()

/** Ids of `initialize` requests, to pick up the negotiated protocol version. */
const initializeIds = new Set()

local.onmessage = (message) => {
  if (message.method === "initialize" && "id" in message) {
    initializeIds.add(message.id)
  }
  upstream.send(message).catch((error) => {
    log(`upstream ${endpoint.href}: ${error?.message ?? error}`)
    // Requests need an answer, or the client would wait forever.
    if ("method" in message && "id" in message) {
      void local.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32603,
          message: `MCPocket server unreachable or rejected the request: ${error?.message ?? error}`,
        },
      })
    }
  })
}

upstream.onmessage = (message) => {
  if ("id" in message && initializeIds.delete(message.id)) {
    const version = message.result?.protocolVersion
    if (version) upstream.setProtocolVersion(version)
  }
  void local.send(message)
}

upstream.onerror = (error) => log(`upstream error: ${error?.message ?? error}`)
local.onerror = (error) => log(`stdio error: ${error?.message ?? error}`)

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await upstream.close().catch(() => {})
  await local.close().catch(() => {})
  process.exit(0)
}
local.onclose = shutdown
process.stdin.on("end", shutdown)
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

await upstream.start()
await local.start()
log(
  `proxying stdio <-> ${endpoint.href}${agentId ? ` as agent ${agentId}` : ""}`
)

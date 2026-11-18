import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js"

import packageJson from "../../package.json"
import { normalizeError } from "../api/errors"
import { actorCan, type Services } from "../services"

import { registerMcpResources } from "./resources"
import { mcpTools, toInputJsonSchema, type McpToolDefinition } from "./tools"

export const MCP_SERVER_NAME = "mcpocket"
export const MCP_SERVER_VERSION: string = packageJson.version

export type CreateMcpServerOptions = {
  /**
   * Application services bound to the authenticated actor of this MCP
   * session/request. Called per tool call, so services are never stale.
   */
  services: () => Promise<Services>
  tools?: McpToolDefinition[]
  /** Overrides the default `MCP_INSTRUCTIONS` (e.g. tube-scoped connections). */
  instructions?: string
}

/** Server instructions sent to clients on `initialize` (also shown on the dashboard MCP page). */
export const MCP_INSTRUCTIONS =
  "MCPocket stores JSON objects (items) in tubes, organised in a folder tree. " +
  "A tube is a persistent work queue: items are pushed in, each is claimed and processed by one agent at a time, and every item keeps its full history. " +
  "Use get_folder_tree (or the mcpocket://folders/tree resource) for an overview, then the folder/tube tools to manage the hierarchy. " +
  "Work loop for agents: claim_next_item → heartbeat_item while working → complete_item | fail_item | release_item; " +
  "your agent identity is the authenticated session, never an argument. " +
  "Media (images, videos, audio, files) is stored once and referenced by URL; items you read back hold URLs, never bytes: pass those URLs on between stages. " +
  "Media is private by default (mcpocket://system/info → media.access): a media URL opens only with your API key (Authorization header) or a dashboard session. To give a file to anything that has no API key — a generator (e.g. an image as a video's first frame), a social network, a player — call create_media_link and hand out data.link (temporary); keep storing the permanent data.url in items. " +
  "Getting a file into storage (mcpocket://system/info → media.enabled): " +
  "(1) a URL — e.g. a generator's temporary link — call ingest_media { url } and use the permanent data.url it returns (plain https URLs in items are stored unchanged, NOT copied, and temporary links expire); " +
  "(2) a local file in your shell — call create_media_upload and run the curl command it returns; " +
  "(3) small files only — embed a data URI with its MIME type (data:image/png;base64,..., optionally data:video/mp4;name=clip.mp4;base64,...) anywhere in a payload, metadata, complete_item result or next item; it is uploaded and replaced by its URL. " +
  "A file above media.maxBytes or outside media.allowedTypes is rejected (payload_too_large / validation_error). When media storage is off, data URIs are stored as sent and the media tools answer conflict. " +
  "Pipelines: each tube is one stage (e.g. prompts → images → videos → captions → publish). Claim an item, do the work, then call complete_item with next: [{ tubeId, payload }] to add a new pending item to the NEXT stage's existing tube (no tube is created; take tube ids from your task or from get_folder_tree / list_tubes) — completing your item and creating the next items is one atomic write. " +
  "Put your generated media URLs in the next payload (and in result if useful) and copy forward what later stages need (e.g. the original prompt); follow the tube's schemaDefinition (mcpocket://tubes/{id}) when it has one. " +
  "Each new item gets metadata.source = { tubeId, itemId, root } (root = the first item of the chain), and the next stage's agent claims it from that tube. " +
  "Long jobs (video generation): claim with leaseSeconds above the expected job time or call heartbeat_item before claim.leaseExpiresAt, or another agent reclaims the item and the work is done twice; leaseSeconds: 0 = a lease that never expires (claim.leaseExpiresAt null). " +
  "Resources: mcpocket://system/info, mcpocket://folders/tree, mcpocket://tubes/{id}, mcpocket://items/{id}. " +
  "Tool results are JSON; errors come back as tool errors with { error: { code, message, details? } } " +
  "(codes: validation_error, not_found, conflict, forbidden, unauthorized, rate_limited, internal_error). " +
  "Only the tools your API key's role allows are listed; data outside its folder/tube scope is invisible."

/** Tool result carrying `data` as JSON text plus `structuredContent`. */
export function toolResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(data !== null &&
      typeof data === "object" &&
      !Array.isArray(data) && {
        structuredContent: data as Record<string, unknown>,
      }),
  }
}

/** Any service error → MCP tool error with the REST error body. */
export function toolError(error: unknown): CallToolResult {
  const body = { error: normalizeError(error) }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  }
}

/**
 * The MCPocket MCP server (`name: "mcpocket"`), transport-agnostic.
 *
 * Tools are served through low-level `tools/list` / `tools/call` handlers
 * instead of `McpServer.registerTool`, because the SDK would validate the
 * arguments itself and report failures as plain text; here the application
 * services validate (same Zod schemas as REST) and errors keep the REST
 * shape. Consequently: add tools to `mcpTools` (lib/mcp/tools), never via
 * `registerTool`. Resources (lib/mcp/resources.ts) and prompts use the
 * `McpServer` API as usual.
 */
export function createMcpServer({
  services,
  tools = mcpTools,
  instructions = MCP_INSTRUCTIONS,
}: CreateMcpServerOptions): McpServer {
  const mcp = new McpServer(
    { name: MCP_SERVER_NAME, title: "MCPocket", version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions,
    }
  )
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const descriptors = tools.map((tool) => ({
    name: tool.name,
    ...(tool.title && { title: tool.title }),
    description: tool.description,
    inputSchema: toInputJsonSchema(tool.input),
    ...(tool.annotations && { annotations: tool.annotations }),
  }))

  registerMcpResources(mcp, {
    services,
    serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    tools,
  })

  // Only the tools the caller's role grants (the services re-check anyway).
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { actor } = await services()
    return {
      tools: descriptors.filter((_, i) =>
        actorCan(actor, tools[i].capability ?? "read")
      ),
    }
  })
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name)
    if (!tool) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Tool ${request.params.name} not found`
      )
    }
    try {
      const result = await tool.run(
        await services(),
        request.params.arguments ?? {}
      )
      return toolResult(result)
    } catch (error) {
      return toolError(error)
    }
  })
  return mcp
}

import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  ErrorCode,
  McpError,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js"

import { normalizeError } from "../api/errors"
import { ITEM_STATUSES } from "../domain/schemas"
import { actorCan, type Services } from "../services"

import type { McpToolDefinition } from "./tools"

/** MCP "resource not found" (spec error code, not in the SDK's `ErrorCode`). */
export const RESOURCE_NOT_FOUND = -32002

/** Resource URIs (plan §5: folder tree, tube descriptions, item details, system info). */
export const MCP_RESOURCE_URIS = {
  folderTree: "mcpocket://folders/tree",
  system: "mcpocket://system/info",
  tube: "mcpocket://tubes/{id}",
  item: "mcpocket://items/{id}",
} as const

/** How many items' recent history the item resource embeds. */
export const ITEM_RESOURCE_HISTORY_LIMIT = 20

/** Registration metadata of each resource (also shown on the dashboard MCP page). */
export const MCP_RESOURCES = {
  folderTree: {
    name: "folder-tree",
    uri: MCP_RESOURCE_URIS.folderTree,
    title: "Folder tree",
    description:
      "The complete folder hierarchy with the tubes in each folder, plus the top-level tubes that have no folder: { data: FolderTreeNode[], rootTubes: Tube[] } (node = Folder & { children, tubes }).",
    mimeType: "application/json",
  },
  system: {
    name: "system-info",
    uri: MCP_RESOURCE_URIS.system,
    title: "System information",
    description:
      "Server name/version, storage driver, media storage ({ enabled, maxBytes, allowedTypes }: whether data URIs in items are uploaded and replaced by URLs), lease defaults, item statuses, available tools and resources, and the identity you are connected as.",
    mimeType: "application/json",
  },
  tube: {
    name: "tube",
    uri: MCP_RESOURCE_URIS.tube,
    title: "Tube description",
    description:
      "A tube's settings including its JSON Schema (schemaDefinition) for item payloads, plus its item count: { data: Tube & { itemCount } }.",
    mimeType: "application/json",
  },
  item: {
    name: "item",
    uri: MCP_RESOURCE_URIS.item,
    title: "Item details",
    description: `One item by id (incl. soft-deleted) with its ${ITEM_RESOURCE_HISTORY_LIMIT} most recent history events: { data: Item, history: { data: HistoryEvent[], page } }.`,
    mimeType: "application/json",
  },
} as const

const meta = ({
  title,
  description,
  mimeType,
}: (typeof MCP_RESOURCES)[keyof typeof MCP_RESOURCES]) => ({
  title,
  description,
  mimeType,
})
/** Upper bound of tubes enumerated by `resources/list`. */
const TUBE_LIST_LIMIT = 1000

export type McpResourceOptions = {
  services: () => Promise<Services>
  serverInfo: { name: string; version: string }
  tools: McpToolDefinition[]
}

const json = (uri: URL, data: unknown): ReadResourceResult => ({
  contents: [
    {
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    },
  ],
})

/** Service errors → JSON-RPC errors (`not_found` → -32002, validation → invalid params). */
function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error
  const body = normalizeError(error)
  const code =
    body.code === "not_found"
      ? RESOURCE_NOT_FOUND
      : body.code === "validation_error"
        ? ErrorCode.InvalidParams
        : ErrorCode.InternalError
  return new McpError(code, body.message, { error: body })
}

const variable = (value: string | string[]) =>
  Array.isArray(value) ? (value[0] ?? "") : value

/**
 * Registers the read-only MCPocket resources on `mcp`. They read through the
 * same application services as the tools, bound to the session's actor.
 */
export function registerMcpResources(
  mcp: McpServer,
  { services, serverInfo, tools }: McpResourceOptions
): void {
  const read =
    (fn: (s: Services) => Promise<unknown>) =>
    async (uri: URL): Promise<ReadResourceResult> => {
      try {
        return json(uri, await fn(await services()))
      } catch (error) {
        throw toMcpError(error)
      }
    }

  mcp.registerResource(
    MCP_RESOURCES.folderTree.name,
    MCP_RESOURCES.folderTree.uri,
    meta(MCP_RESOURCES.folderTree),
    read(async (s) => {
      const { folders, tubes } = await s.folders.hierarchy()
      return { data: folders, rootTubes: tubes }
    })
  )

  mcp.registerResource(
    MCP_RESOURCES.system.name,
    MCP_RESOURCES.system.uri,
    meta(MCP_RESOURCES.system),
    read(async (s) => ({
      data: {
        server: serverInfo,
        storage: { driver: s.ctx.storage.driver },
        media: s.media.status(),
        processing: {
          defaultLeaseSeconds: s.ctx.leaseSeconds,
          itemStatuses: ITEM_STATUSES,
        },
        you: s.actor,
        tools: tools
          .filter((t) => actorCan(s.actor, t.capability ?? "read"))
          .map((t) => t.name),
        resources: Object.values(MCP_RESOURCE_URIS),
        time: s.ctx.clock.now().toISOString(),
      },
    }))
  )

  mcp.registerResource(
    MCP_RESOURCES.tube.name,
    new ResourceTemplate(MCP_RESOURCES.tube.uri, {
      list: async () => {
        const { data } = await (
          await services()
        ).tubes.list({ limit: TUBE_LIST_LIMIT })
        return {
          resources: data.map((tube) => ({
            uri: `mcpocket://tubes/${tube.id}`,
            name: tube.name,
            title: `Tube: ${tube.name}`,
            ...(tube.description && { description: tube.description }),
            mimeType: "application/json",
          })),
        }
      },
    }),
    meta(MCP_RESOURCES.tube),
    async (uri, { id }) =>
      read(async (s) => {
        const tube = await s.tubes.get(variable(id))
        const { page } = await s.items.list(tube.id, { limit: 1 })
        return { data: { ...tube, itemCount: page.total } }
      })(uri)
  )

  mcp.registerResource(
    MCP_RESOURCES.item.name,
    new ResourceTemplate(MCP_RESOURCES.item.uri, { list: undefined }),
    meta(MCP_RESOURCES.item),
    async (uri, { id }) =>
      read(async (s) => {
        const item = await s.items.get(variable(id))
        const history = await s.items.history(item.id, {
          limit: ITEM_RESOURCE_HISTORY_LIMIT,
        })
        return { data: item, history }
      })(uri)
  )
}

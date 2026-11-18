import "server-only"

import appPackage from "@/package.json"

import {
  ROLES,
  ROLE_CAPABILITIES,
  type Capability,
  type Role,
} from "@mcpocket/core/domain/access"
import { ITEM_STATUSES } from "@mcpocket/core/domain/schemas"
import { MCP_RESOURCES } from "@mcpocket/core/mcp/resources"
import { MCP_INSTRUCTIONS, MCP_SERVER_NAME } from "@mcpocket/core/mcp/server"
import { LEGACY_MESSAGES_PATH, LEGACY_SSE_PATH } from "@mcpocket/core/mcp/sse"
import { toInputJsonSchema, type McpToolDefinition } from "@mcpocket/core/mcp/tools"
import { folderTools } from "@mcpocket/core/mcp/tools/folders"
import { itemTools, processingTools } from "@mcpocket/core/mcp/tools/items"
import { statisticsTools } from "@mcpocket/core/mcp/tools/statistics"
import { tubeTools } from "@mcpocket/core/mcp/tools/tubes"
import {
  FOLDER_SCOPED_DEFAULT_ARGS,
  FOLDER_SCOPED_PROTECTED_TOOLS,
  TUBE_SCOPED_HIDDEN_TOOLS,
  type ScopeTarget,
} from "@mcpocket/core/mcp/connection-scope"

export const MCP_HTTP_PATH = "/api/mcp"

/** Error codes tool errors carry in `{ error: { code } }` (see server instructions). */
export const MCP_ERROR_CODES = [
  "validation_error",
  "not_found",
  "conflict",
  "forbidden",
  "unauthorized",
  "rate_limited",
  "internal_error",
] as const

export type McpToolParam = {
  name: string
  type: string
  required: boolean
  description?: string
}

/** Serializable view of one MCP tool for the dashboard. */
export type McpToolInfo = {
  name: string
  title?: string
  description: string
  capability: Capability
  roles: Role[]
  hints: { readOnly: boolean; destructive: boolean; idempotent: boolean }
  params: McpToolParam[]
  inputSchema: string
  /** On tube-scoped connections: hidden, or `tubeId` becomes optional. */
  tubeScoped: "hidden" | "defaults-tube" | "same"
  /** On folder-scoped connections: an argument defaulting to the folder, or protection of the bound folder. */
  folderScoped:
    | { kind: "defaults-folder"; arg: string }
    | { kind: "protects-folder" }
    | { kind: "same" }
}

export type McpToolGroup = { id: string; label: string; tools: McpToolInfo[] }

const GROUPS: { id: string; label: string; tools: McpToolDefinition[] }[] = [
  { id: "folders", label: "Folders", tools: folderTools },
  { id: "tubes", label: "Tubes", tools: tubeTools },
  { id: "items", label: "Items", tools: itemTools },
  {
    id: "processing",
    label: "Processing (agent work loop)",
    tools: processingTools,
  },
  { id: "statistics", label: "Statistics", tools: statisticsTools },
]

function describeType(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) return schema.enum.map(String).join(" | ")
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const options = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[]
    return [...new Set(options.map(describeType))].join(" | ")
  }
  if (
    schema.type === "array" &&
    schema.items &&
    typeof schema.items === "object"
  ) {
    return `${describeType(schema.items as Record<string, unknown>)}[]`
  }
  if (Array.isArray(schema.type)) return schema.type.join(" | ")
  if (typeof schema.type === "string") return schema.type
  return "any"
}

function toToolInfo(tool: McpToolDefinition): McpToolInfo {
  const capability = tool.capability ?? "read"
  const schema = toInputJsonSchema(tool.input)
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >
  const required = new Set((schema.required as string[] | undefined) ?? [])
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    capability,
    roles: ROLES.filter((role) => ROLE_CAPABILITIES[role].includes(capability)),
    hints: {
      readOnly: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint === true,
      idempotent: tool.annotations?.idempotentHint === true,
    },
    params: Object.entries(properties).map(([name, prop]) => ({
      name,
      type: describeType(prop),
      required: required.has(name),
      ...(typeof prop.description === "string" && {
        description: prop.description,
      }),
    })),
    inputSchema: JSON.stringify(schema, null, 2),
    tubeScoped: TUBE_SCOPED_HIDDEN_TOOLS.has(tool.name)
      ? "hidden"
      : "tubeId" in properties
        ? "defaults-tube"
        : "same",
    folderScoped: FOLDER_SCOPED_DEFAULT_ARGS[tool.name]
      ? { kind: "defaults-folder", arg: FOLDER_SCOPED_DEFAULT_ARGS[tool.name] }
      : FOLDER_SCOPED_PROTECTED_TOOLS.has(tool.name)
        ? { kind: "protects-folder" }
        : { kind: "same" },
  }
}

/** MCP endpoint URLs, optionally bound to one tube or folder. */
export function mcpEndpoints(baseUrl: string, target?: ScopeTarget) {
  const id = target ? encodeURIComponent(target.id) : null
  const segment = target?.kind === "folder" ? "folders" : "tubes"
  const param = target?.kind === "folder" ? "folderId" : "tubeId"
  return {
    http: id
      ? `${baseUrl}${MCP_HTTP_PATH}/${segment}/${id}`
      : `${baseUrl}${MCP_HTTP_PATH}`,
    sse: id
      ? `${baseUrl}${LEGACY_SSE_PATH}?${param}=${id}`
      : `${baseUrl}${LEGACY_SSE_PATH}`,
    messages: `${baseUrl}${LEGACY_MESSAGES_PATH}?sessionId=…`,
  }
}

/** Everything the dashboard MCP page shows, derived from the live server definition. */
export function getMcpOverview(baseUrl: string, target?: ScopeTarget) {
  const groups: McpToolGroup[] = GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    tools: group.tools.map(toToolInfo),
  }))
  const toolCount = groups.reduce((n, g) => n + g.tools.length, 0)
  return {
    server: {
      name: MCP_SERVER_NAME,
      version: appPackage.version,
      instructions: MCP_INSTRUCTIONS,
    },
    endpoints: mcpEndpoints(baseUrl, target),
    tubeScopedToolCount: groups
      .flatMap((g) => g.tools)
      .filter((t) => t.tubeScoped !== "hidden").length,
    baseUrl,
    groups,
    toolCount,
    toolsPerRole: Object.fromEntries(
      ROLES.map((role) => [
        role,
        groups.flatMap((g) => g.tools).filter((t) => t.roles.includes(role))
          .length,
      ])
    ) as Record<Role, number>,
    resources: Object.values(MCP_RESOURCES).map((r) => ({
      ...r,
      template: r.uri.includes("{"),
    })),
    itemStatuses: ITEM_STATUSES,
    errorCodes: MCP_ERROR_CODES,
  }
}

export type McpOverview = ReturnType<typeof getMcpOverview>

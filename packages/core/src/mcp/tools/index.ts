import type { McpToolDefinition } from "./define"
import { folderTools } from "./folders"
import { itemTools, processingTools } from "./items"
import { mediaTools } from "./media"
import { statisticsTools } from "./statistics"
import { tubeTools } from "./tubes"

export * from "./define"

/**
 * Every MCP tool, served identically on all transports (Streamable HTTP,
 * legacy SSE and — via the HTTP proxy — stdio). New tool groups are added
 * here (e.g. search/bulk in ticket 08).
 */
export const mcpTools: McpToolDefinition[] = [
  ...folderTools,
  ...tubeTools,
  ...itemTools,
  ...processingTools,
  ...mediaTools,
  ...statisticsTools,
]

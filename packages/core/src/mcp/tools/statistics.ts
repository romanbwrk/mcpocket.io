import { z } from "zod"

import {
  AgentStatisticsInputSchema,
  ProcessingErrorsInputSchema,
} from "../../services"

import { defineTool, IdArgSchema, splitId } from "./define"

/** Monitoring tools (plan §5.5) + `get_tube_statistics` (§5.2). Same shapes as REST /api/statistics/*. */
export const statisticsTools = [
  defineTool({
    name: "get_statistics",
    capability: "read",
    title: "Get global statistics",
    description:
      "Global monitoring: non-deleted item counts by status (total, pending, processing, completed, failed, retry, cancelled, archived) across all tubes, plus folder/tube/agent totals. Returns { data: { counts, folders, tubes, agents, generatedAt } }.",
    input: z.object({}),
    annotations: { readOnlyHint: true },
    run: async (services) => ({ data: await services.statistics.global() }),
  }),
  defineTool({
    name: "get_tube_statistics",
    capability: "read",
    title: "Get tube statistics",
    description:
      "Item counts by status for one tube. Returns { data: { tubeId, tubeName, folderId, enabled, counts, generatedAt } }.",
    input: IdArgSchema,
    annotations: { readOnlyHint: true },
    run: async (services, args) => {
      const { id } = splitId(args)
      return { data: await services.statistics.tube(id) }
    },
  }),
  defineTool({
    name: "get_agent_statistics",
    capability: "read",
    title: "Get agent statistics",
    description:
      "Per-agent activity, most recently seen first: assigned (items attributed to the agent), processing, completed and failed (from audit history), lastHeartbeatAt, lastSeenAt. Optional agentId filter. Returns { data: AgentStatistics[], page }.",
    input: AgentStatisticsInputSchema,
    annotations: { readOnlyHint: true },
    run: (services, args) => services.statistics.agents(args),
  }),
  defineTool({
    name: "get_processing_errors",
    capability: "read",
    title: "Get processing errors",
    description:
      "Failed items with their last error, newest failure first. Filter by tubeId, agentId (assigned agent) and status (default failed; e.g. ['failed','retry']). Returns { data: [{ itemId, tubeId, status, attempts, assignedAgent, error, failedAt }], page }.",
    input: ProcessingErrorsInputSchema,
    annotations: { readOnlyHint: true },
    run: (services, args) => services.statistics.errors(args),
  }),
]

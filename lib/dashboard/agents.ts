import { ITEM_STATUSES, type ItemStatus } from "@mcpocket/core/domain/schemas"

import {
  EMPTY_TUBE_VIEW_QUERY,
  toURLSearchParams,
  tubeViewHref,
  type SearchParamsRecord,
} from "./tube-query"

/**
 * Agents pages URL helpers (client-safe). Agent detail view state:
 * `/dashboard/agents/<agentId>?status=a,b&page=N` — the same `status` format
 * as `GET /api/agents/{id}/items`.
 */

export const AGENT_ITEMS_PAGE_SIZE = 25

export type AgentViewQuery = {
  status: ItemStatus[]
  /** 1-based. */
  page: number
}

export function agentHref(
  agentId: string,
  query: Partial<AgentViewQuery> = {}
): string {
  const params = new URLSearchParams()
  if (query.status?.length) params.set("status", query.status.join(","))
  if (query.page && query.page > 1) params.set("page", String(query.page))
  const search = params.toString()
  const path = `/dashboard/agents/${encodeURIComponent(agentId)}`
  return search ? `${path}?${search}` : path
}

/** Lenient URL → agent view state (unknown statuses / bad pages dropped). */
export function parseAgentViewQuery(
  input: SearchParamsRecord | URLSearchParams
): AgentViewQuery {
  const params = toURLSearchParams(input)
  const wanted = new Set(
    params
      .getAll("status")
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
  )
  const rawPage = params.get("page")?.trim() ?? ""
  const page = /^\d+$/.test(rawPage) ? Number(rawPage) : 1
  return {
    status: ITEM_STATUSES.filter((s) => wanted.has(s)),
    page: page > 0 ? page : 1,
  }
}

/** Input for `services.processing.agentItems`. */
export function agentItemsInput(query: AgentViewQuery) {
  return {
    ...(query.status.length > 0 && { status: query.status }),
    offset: (query.page - 1) * AGENT_ITEMS_PAGE_SIZE,
    limit: AGENT_ITEMS_PAGE_SIZE,
  }
}

/**
 * Agent id from the `[agentId]` route segment. Agent ids never contain `%`
 * (`AgentIdSchema`), so decoding is safe whether or not Next already did.
 */
export function decodeAgentIdParam(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Tube view filtered to the agent's items. */
export function agentTubeHref(tubeId: string, agentId: string): string {
  return tubeViewHref(`/dashboard/tubes/${tubeId}`, {
    ...EMPTY_TUBE_VIEW_QUERY,
    assignedAgent: agentId,
  })
}

/** Tube view filtered to the agent, with the item open in the inspector. */
export function agentItemHref(
  tubeId: string,
  itemId: string,
  agentId: string
): string {
  return tubeViewHref(
    `/dashboard/tubes/${tubeId}`,
    { ...EMPTY_TUBE_VIEW_QUERY, assignedAgent: agentId },
    { item: itemId }
  )
}

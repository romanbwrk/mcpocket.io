import { z } from "zod"

import type { Actor } from "../domain/actor"
import { NotFoundError } from "../domain/errors"
import { StatusFilterSchema } from "../domain/item-filter"
import { PageInputSchema, type PageResult } from "../domain/pagination"
import {
  IdSchema,
  ITEM_STATUSES,
  type HistoryEvent,
  type Item,
  type ItemError,
  type ItemStatus,
} from "../domain/schemas"

import { createAccessControl } from "./access"
import type { ServiceContext } from "./context"
import { AgentIdSchema } from "./processing"

/** Item counts by status (non-deleted items only). `total` = sum of all statuses. */
export type StatusCounts = { total: number } & Record<ItemStatus, number>

export type GlobalStatistics = {
  counts: StatusCounts
  folders: number
  tubes: number
  /** Distinct agents known from items (`assignedAgent`) or audit history. */
  agents: number
  generatedAt: string
}

export type TubeStatistics = {
  tubeId: string
  tubeName: string
  /** `null` for top-level tubes. */
  folderId: string | null
  enabled: boolean
  counts: StatusCounts
  generatedAt: string
}

export type AgentStatistics = {
  agentId: string
  /** Non-deleted items currently attributed to the agent (`assignedAgent`, any status). */
  assigned: number
  /** Of those, items in `processing` (lease may have expired). */
  processing: number
  /** `completed` audit events written by the agent. */
  completed: number
  /** `failed` audit events written by the agent. */
  failed: number
  /** Latest `heartbeat` audit event by the agent, or null. */
  lastHeartbeatAt: string | null
  /** Latest audit event of any kind (claim, heartbeat, complete, …) by the agent, or null. */
  lastSeenAt: string | null
}

export type ProcessingErrorEntry = {
  itemId: string
  tubeId: string
  status: ItemStatus
  attempts: number
  assignedAgent: string | null
  /** `item.lastError`; null when the item reached its status without `fail`. */
  error: ItemError | null
  /** `error.at`, else the item's `updatedAt`. Sort key (newest first). */
  failedAt: string
}

export const AgentStatisticsInputSchema = PageInputSchema.extend({
  /** Restrict to one agent. */
  agentId: AgentIdSchema.optional(),
})
export type AgentStatisticsInput = z.input<typeof AgentStatisticsInputSchema>

export const ProcessingErrorsInputSchema = PageInputSchema.extend({
  tubeId: IdSchema.optional(),
  /** Agent the item is attributed to (`assignedAgent`). */
  agentId: AgentIdSchema.optional(),
  /** Item statuses to include (one, array or comma list). Default: failed. */
  status: StatusFilterSchema.optional(),
})
export type ProcessingErrorsInput = z.input<typeof ProcessingErrorsInputSchema>

const AGENT_ACTOR_PREFIX = "agent:"

export function countByStatus(items: Item[]): StatusCounts {
  const counts = Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0])) as Record<
    ItemStatus,
    number
  >
  for (const item of items) counts[item.status]++
  return { total: items.length, ...counts }
}

const page = <T>(
  all: T[],
  { offset, limit }: { offset: number; limit: number }
): PageResult<T> => ({
  data: all.slice(offset, offset + limit),
  page: { offset, limit, total: all.length },
})

export type StatisticsService = ReturnType<typeof createStatisticsService>

/**
 * Read-only monitoring (plan §5.5 / §6 Monitoring). Computed in memory from
 * the repositories on every call (v1 JSON storage); REST and MCP both return
 * exactly these shapes.
 */
export function createStatisticsService(ctx: ServiceContext, actor: Actor) {
  const { storage } = ctx
  const now = () => ctx.clock.now().toISOString()
  const ac = createAccessControl(ctx, actor)

  /**
   * Ids of the tubes a scoped caller may see (`null` = all). Statistics of a
   * scoped key only count items of its tubes (and their history).
   */
  async function allowedTubeIds(): Promise<Set<string> | null> {
    ac.require("read")
    const scope = await ac.view()
    if (scope.unrestricted) return null
    return new Set(
      (await storage.tubes.list())
        .filter((t) => scope.canAccessTube(t))
        .map((t) => t.id)
    )
  }

  async function scopedItems(
    allowed: Set<string> | null,
    query: Parameters<typeof storage.items.list>[0] = {}
  ): Promise<Item[]> {
    const items = await storage.items.list(query)
    return allowed ? items.filter((i) => allowed.has(i.tubeId)) : items
  }

  async function scopedHistory(
    allowed: Set<string> | null
  ): Promise<HistoryEvent[]> {
    const history = await storage.history.list()
    if (!allowed) return history
    const itemIds = new Set(
      (await storage.items.list({ includeDeleted: true }))
        .filter((i) => allowed.has(i.tubeId))
        .map((i) => i.id)
    )
    return history.filter((e) => itemIds.has(e.itemId))
  }

  async function agentStats(
    allowed: Set<string> | null
  ): Promise<AgentStatistics[]> {
    const [items, history] = await Promise.all([
      scopedItems(allowed),
      scopedHistory(allowed),
    ])
    const byAgent = new Map<string, AgentStatistics>()
    const entry = (agentId: string) => {
      let stats = byAgent.get(agentId)
      if (!stats) {
        stats = {
          agentId,
          assigned: 0,
          processing: 0,
          completed: 0,
          failed: 0,
          lastHeartbeatAt: null,
          lastSeenAt: null,
        }
        byAgent.set(agentId, stats)
      }
      return stats
    }
    for (const item of items) {
      if (!item.assignedAgent) continue
      const stats = entry(item.assignedAgent)
      stats.assigned++
      if (item.status === "processing") stats.processing++
    }
    // History is newest first: the first event seen per agent is the latest.
    for (const event of history) {
      if (!event.actor.startsWith(AGENT_ACTOR_PREFIX)) continue
      const stats = entry(event.actor.slice(AGENT_ACTOR_PREFIX.length))
      stats.lastSeenAt ??= event.createdAt
      if (event.action === "heartbeat")
        stats.lastHeartbeatAt ??= event.createdAt
      else if (event.action === "completed") stats.completed++
      else if (event.action === "failed") stats.failed++
    }
    return [...byAgent.values()].sort(
      (a, b) =>
        (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") ||
        a.agentId.localeCompare(b.agentId)
    )
  }

  return {
    /** Item counts by status across all tubes, plus entity totals. */
    async global(): Promise<GlobalStatistics> {
      const allowed = await allowedTubeIds()
      const scope = await ac.view()
      const [items, folders, tubes, agents] = await Promise.all([
        scopedItems(allowed),
        allowed
          ? storage.folders
              .list()
              .then((all) => all.filter((f) => scope.canSeeFolder(f.id)).length)
          : storage.folders.count(),
        allowed ? allowed.size : storage.tubes.count(),
        agentStats(allowed),
      ])
      return {
        counts: countByStatus(items),
        folders,
        tubes,
        agents: agents.length,
        generatedAt: now(),
      }
    },

    /** Item counts by status for one tube (404 if missing). */
    async tube(id: string): Promise<TubeStatistics> {
      IdSchema.parse(id)
      ac.require("read")
      const tube = await storage.tubes.get(id)
      if (!tube) throw new NotFoundError("Tube", id)
      ac.assertTube(await ac.view(), tube)
      const items = await storage.items.list({ tubeId: id })
      return {
        tubeId: tube.id,
        tubeName: tube.name,
        folderId: tube.folderId,
        enabled: tube.enabled,
        counts: countByStatus(items),
        generatedAt: now(),
      }
    },

    /** Per-agent activity, most recently seen first (agents never seen last, by id). */
    async agents(input: unknown = {}): Promise<PageResult<AgentStatistics>> {
      const { agentId, ...pageInput } = AgentStatisticsInputSchema.parse(input)
      const all = await agentStats(await allowedTubeIds())
      return page(
        agentId ? all.filter((a) => a.agentId === agentId) : all,
        pageInput
      )
    },

    /** Failed (by default) items with their last error, newest failure first. */
    async errors(
      input: unknown = {}
    ): Promise<PageResult<ProcessingErrorEntry>> {
      const { tubeId, agentId, status, ...pageInput } =
        ProcessingErrorsInputSchema.parse(input)
      const items = await scopedItems(await allowedTubeIds(), {
        tubeId,
        assignedAgent: agentId,
        status: status ?? "failed",
      })
      const entries = items
        .map((item): ProcessingErrorEntry => ({
          itemId: item.id,
          tubeId: item.tubeId,
          status: item.status,
          attempts: item.attempts,
          assignedAgent: item.assignedAgent ?? null,
          error: item.lastError ?? null,
          failedAt: item.lastError?.at ?? item.updatedAt,
        }))
        .sort(
          (a, b) =>
            b.failedAt.localeCompare(a.failedAt) ||
            a.itemId.localeCompare(b.itemId)
        )
      return page(entries, pageInput)
    },
  }
}

import {
  AlertTriangleIcon,
  BotIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InboxIcon,
} from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ZodError } from "zod"

import {
  LiveAvailabilityBadge,
  LiveTimeAgo,
} from "@/components/dashboard/agent-availability"
import {
  ITEM_STATUS_META,
  ItemStatusBadge,
  StatusDot,
} from "@/components/dashboard/item-status"
import { UtcTime } from "@/components/dashboard/utc-time"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getUserServices } from "@/lib/auth/server"
import {
  AGENT_ITEMS_PAGE_SIZE,
  agentHref,
  agentItemHref,
  agentItemsInput,
  agentTubeHref,
  decodeAgentIdParam,
  parseAgentViewQuery,
  type AgentViewQuery,
} from "@/lib/dashboard/agents"
import {
  availabilityThresholdsFromEnv,
  lastActivityAt,
} from "@mcpocket/core/domain/agent-availability"
import type { ItemStatus } from "@mcpocket/core/domain/schemas"
import type { Services } from "@mcpocket/core/services"
import type { AgentStatistics } from "@mcpocket/core/services/statistics"
import { cn } from "@/lib/utils"

const FILTER_STATUSES: ItemStatus[] = [
  "processing",
  "completed",
  "failed",
  "retry",
  "pending",
  "cancelled",
  "archived",
]
const RECENT_ERRORS = 5

async function loadAgent(
  services: Services,
  agentId: string
): Promise<AgentStatistics | null> {
  try {
    const result = await services.statistics.agents({ agentId, limit: 1 })
    return result.data[0] ?? null
  } catch (error) {
    if (error instanceof ZodError) return null // not a valid agent id
    throw error
  }
}

export async function generateMetadata({
  params,
}: PageProps<"/dashboard/agents/[agentId]">): Promise<Metadata> {
  const { agentId } = await params
  return { title: `Agent ${decodeAgentIdParam(agentId)}` }
}

/**
 * One agent: availability, counters, the items currently attributed to it
 * (links into the tube view filtered by the agent, with the inspector open)
 * and its most recent processing errors.
 */
export default async function AgentPage({
  params,
  searchParams,
}: PageProps<"/dashboard/agents/[agentId]">) {
  const [{ agentId: rawId }, rawQuery] = await Promise.all([
    params,
    searchParams,
  ])
  const agentId = decodeAgentIdParam(rawId)
  const services = await getUserServices()
  const agent = await loadAgent(services, agentId)
  if (!agent) notFound()

  const query = parseAgentViewQuery(rawQuery)
  const thresholds = availabilityThresholdsFromEnv()
  const serverNow = new Date().toISOString()
  const [items, errors, tubes] = await Promise.all([
    services.processing.agentItems(agentId, agentItemsInput(query)),
    services.statistics.errors({ agentId, limit: RECENT_ERRORS }),
    services.tubes.list({ limit: 1000 }),
  ])
  const tubeNames = new Map(tubes.data.map((t) => [t.id, t.name]))
  const tubeName = (id: string) => tubeNames.get(id) ?? id.slice(0, 8)

  const tiles = [
    {
      key: "assigned",
      label: "Assigned",
      value: agent.assigned,
      href: agentHref(agentId),
      active: query.status.length === 0,
    },
    {
      key: "processing",
      label: "Processing",
      value: agent.processing,
      href: agentHref(agentId, { status: ["processing"] }),
      active: query.status.length === 1 && query.status[0] === "processing",
    },
    { key: "completed", label: "Completed", value: agent.completed },
    { key: "failed", label: "Failed", value: agent.failed },
  ]

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col gap-2">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1 text-xs text-muted-foreground"
        >
          <Link href="/dashboard/agents" className="hover:text-foreground">
            Agents
          </Link>
          <ChevronRightIcon className="size-3" />
          <span className="text-foreground">{agentId}</span>
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <BotIcon className="size-5 text-muted-foreground" />
          <h1 className="font-mono text-lg font-semibold tracking-tight">
            {agentId}
          </h1>
          <LiveAvailabilityBadge
            lastActivity={lastActivityAt(agent)}
            thresholds={thresholds}
            serverNow={serverNow}
          />
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Last heartbeat</dt>
            <dd data-testid="agent-last-heartbeat">
              <LiveTimeAgo iso={agent.lastHeartbeatAt} serverNow={serverNow} />
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Last activity</dt>
            <dd>
              <LiveTimeAgo iso={lastActivityAt(agent)} serverNow={serverNow} />
            </dd>
          </div>
        </dl>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border ring-1 ring-border sm:grid-cols-4">
        {tiles.map((tile) => {
          const body = (
            <>
              <span className="text-[0.7rem] text-muted-foreground">
                {tile.label}
              </span>
              <span
                className={cn(
                  "text-xl font-semibold tabular-nums",
                  tile.key === "failed" && tile.value > 0 && "text-destructive"
                )}
              >
                {tile.value}
              </span>
            </>
          )
          const className = cn(
            "flex flex-col gap-1 bg-card px-3 py-2.5",
            tile.href &&
              "transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            tile.active &&
              "bg-muted shadow-[inset_0_-2px_0_var(--color-primary)]"
          )
          return tile.href ? (
            <Link
              key={tile.key}
              href={tile.href}
              scroll={false}
              aria-current={tile.active ? "true" : undefined}
              data-testid={`agent-counter-${tile.key}`}
              className={className}
            >
              {body}
            </Link>
          ) : (
            <div
              key={tile.key}
              data-testid={`agent-counter-${tile.key}`}
              className={className}
              title="Audit events written by the agent"
            >
              {body}
            </div>
          )
        })}
      </div>

      <section className="flex flex-col gap-2" aria-labelledby="assigned-items">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="assigned-items" className="text-sm font-semibold">
            Assigned items
          </h2>
          <StatusFilter agentId={agentId} query={query} />
        </div>
        {items.data.length === 0 ? (
          <Empty
            className="border border-dashed"
            data-testid="agent-items-empty"
          >
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <InboxIcon />
              </EmptyMedia>
              <EmptyTitle>
                {items.page.total > 0
                  ? "No items on this page"
                  : query.status.length > 0
                    ? "No items with this status"
                    : "No items assigned"}
              </EmptyTitle>
              <EmptyDescription>
                Items stay attributed to the agent after it completes or fails
                them, until they are released or reassigned.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Tube</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead>Lease expires (UTC)</TableHead>
                    <TableHead>Updated (UTC)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.data.map((item) => (
                    <TableRow key={item.id} data-item-id={item.id}>
                      <TableCell>
                        <Link
                          href={agentItemHref(item.tubeId, item.id, agentId)}
                          className="font-mono text-[0.7rem] underline-offset-2 hover:underline"
                          title={`Inspect ${item.id}`}
                        >
                          {item.id.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-48 truncate">
                        <Link
                          href={agentTubeHref(item.tubeId, agentId)}
                          className="underline-offset-2 hover:underline"
                          title="Open the tube filtered by this agent"
                        >
                          {tubeName(item.tubeId)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <ItemStatusBadge status={item.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {item.attempts}
                      </TableCell>
                      <TableCell>
                        {item.status === "processing" && item.leaseExpiresAt ? (
                          <UtcTime iso={item.leaseExpiresAt} seconds />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <UtcTime iso={item.updatedAt} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination
              agentId={agentId}
              query={query}
              total={items.page.total}
              shown={items.data.length}
            />
          </>
        )}
      </section>

      {errors.data.length > 0 && (
        <section
          className="flex flex-col gap-2"
          aria-labelledby="recent-errors"
        >
          <h2
            id="recent-errors"
            className="flex items-center gap-1.5 text-sm font-semibold"
          >
            <AlertTriangleIcon className="size-4 text-destructive" />
            Recent errors
            <span className="font-normal text-muted-foreground">
              ({errors.page.total} failed)
            </span>
          </h2>
          <ul className="flex flex-col divide-y border bg-card text-xs">
            {errors.data.map((entry) => (
              <li
                key={entry.itemId}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2"
              >
                <Link
                  href={agentItemHref(entry.tubeId, entry.itemId, agentId)}
                  className="font-mono text-[0.7rem] underline-offset-2 hover:underline"
                >
                  {entry.itemId.slice(0, 8)}
                </Link>
                <span className="text-muted-foreground">
                  {tubeName(entry.tubeId)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {entry.error?.code && (
                    <code className="mr-1.5">{entry.error.code}</code>
                  )}
                  {entry.error?.message ?? "No error recorded"}
                </span>
                <UtcTime iso={entry.failedAt} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function StatusFilter({
  agentId,
  query,
}: {
  agentId: string
  query: AgentViewQuery
}) {
  const chip = (active: boolean) =>
    cn(
      "inline-flex h-6 items-center gap-1.5 border px-2 text-[0.7rem] transition-colors hover:bg-muted",
      active ? "border-primary bg-muted font-medium" : "text-muted-foreground"
    )
  return (
    <nav aria-label="Status filter" className="flex flex-wrap gap-1">
      <Link
        href={agentHref(agentId)}
        scroll={false}
        aria-current={query.status.length === 0 ? "true" : undefined}
        className={chip(query.status.length === 0)}
      >
        All
      </Link>
      {FILTER_STATUSES.map((status) => {
        const only = query.status.length === 1 && query.status[0] === status
        return (
          <Link
            key={status}
            href={agentHref(agentId, { status: only ? [] : [status] })}
            scroll={false}
            aria-current={query.status.includes(status) ? "true" : undefined}
            data-testid={`agent-status-${status}`}
            className={chip(query.status.includes(status))}
          >
            <StatusDot status={status} />
            {ITEM_STATUS_META[status].label}
          </Link>
        )
      })}
    </nav>
  )
}

function Pagination({
  agentId,
  query,
  total,
  shown,
}: {
  agentId: string
  query: AgentViewQuery
  total: number
  shown: number
}) {
  const pages = Math.max(1, Math.ceil(total / AGENT_ITEMS_PAGE_SIZE))
  const from = (query.page - 1) * AGENT_ITEMS_PAGE_SIZE + 1
  const to = from + shown - 1
  const link = (page: number | null, label: string, icon: React.ReactNode) =>
    page === null ? (
      <Button size="icon-sm" variant="outline" disabled aria-label={label}>
        {icon}
      </Button>
    ) : (
      <Button
        size="icon-sm"
        variant="outline"
        aria-label={label}
        nativeButton={false}
        render={
          <Link
            href={agentHref(agentId, { status: query.status, page })}
            scroll={false}
          />
        }
      >
        {icon}
      </Button>
    )
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span className="tabular-nums">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-2">
        <span className="tabular-nums">
          Page {Math.min(query.page, pages)} / {pages}
        </span>
        {link(
          query.page > 1 ? query.page - 1 : null,
          "Previous page",
          <ChevronLeftIcon />
        )}
        {link(
          query.page < pages ? query.page + 1 : null,
          "Next page",
          <ChevronRightIcon />
        )}
      </div>
    </div>
  )
}

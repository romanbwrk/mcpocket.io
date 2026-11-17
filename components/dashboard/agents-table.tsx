"use client"

import { BotIcon } from "lucide-react"
import Link from "next/link"
import * as React from "react"

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
import { agentHref } from "@/lib/dashboard/agents"
import {
  agentAvailability,
  AGENT_AVAILABILITIES,
  lastActivityAt,
  type AgentAvailability,
  type AvailabilityThresholds,
} from "@mcpocket/core/domain/agent-availability"
import type { AgentStatistics } from "@mcpocket/core/services/statistics"
import { cn } from "@/lib/utils"

import {
  AVAILABILITY_META,
  AvailabilityBadge,
  AvailabilityDot,
  TimeAgo,
  useNow,
} from "./agent-availability"

type Filter = "all" | AgentAvailability

/**
 * Agents overview: availability counters (doubling as a filter) and one row
 * per known agent. Availability is computed on the client's ticking clock;
 * counts and timestamps come from the server (refreshed by live updates).
 */
export function AgentsTable({
  agents,
  thresholds,
  serverNow,
}: {
  agents: AgentStatistics[]
  thresholds: AvailabilityThresholds
  serverNow: string
}) {
  const now = useNow(serverNow)
  const [filter, setFilter] = React.useState<Filter>("all")

  const rows = agents.map((agent) => {
    const activity = lastActivityAt(agent)
    return {
      agent,
      activity,
      availability: agentAvailability(activity, now, thresholds),
    }
  })
  const counts = Object.fromEntries(
    AGENT_AVAILABILITIES.map((a) => [
      a,
      rows.filter((r) => r.availability === a).length,
    ])
  ) as Record<AgentAvailability, number>
  const visible =
    filter === "all" ? rows : rows.filter((r) => r.availability === filter)

  const tiles: { key: Filter; label: string; value: number }[] = [
    { key: "all", label: "All agents", value: rows.length },
    ...AGENT_AVAILABILITIES.map((a) => ({
      key: a,
      label: AVAILABILITY_META[a].label,
      value: counts[a],
    })),
  ]

  return (
    <div className="flex flex-col gap-4">
      <div
        role="group"
        aria-label="Availability"
        className="grid grid-cols-2 gap-px bg-border ring-1 ring-border sm:grid-cols-4"
      >
        {tiles.map((tile) => {
          const active = filter === tile.key
          return (
            <button
              key={tile.key}
              type="button"
              aria-pressed={active}
              data-testid={`availability-${tile.key}`}
              title={
                tile.key === "all"
                  ? undefined
                  : AVAILABILITY_META[tile.key].hint(thresholds)
              }
              onClick={() =>
                setFilter(active && tile.key !== "all" ? "all" : tile.key)
              }
              className={cn(
                "flex flex-col gap-1 bg-card px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                active &&
                  "bg-muted shadow-[inset_0_-2px_0_var(--color-primary)]"
              )}
            >
              <span className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
                {tile.key !== "all" && (
                  <AvailabilityDot availability={tile.key} />
                )}
                {tile.label}
              </span>
              <span className="text-xl font-semibold tabular-nums">
                {tile.value}
              </span>
            </button>
          )
        })}
      </div>

      {visible.length === 0 ? (
        <Empty className="border border-dashed" data-testid="agents-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>
              {rows.length === 0
                ? "No agents yet"
                : `No ${AVAILABILITY_META[filter as AgentAvailability].label.toLowerCase()} agents`}
            </EmptyTitle>
            <EmptyDescription>
              {rows.length === 0 ? (
                <>
                  Agents appear once they claim an item (REST{" "}
                  <code>X-Agent-Id</code> or an MCP session with an agent id).
                </>
              ) : (
                "Pick another availability above."
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Availability</TableHead>
                <TableHead className="text-right">Assigned</TableHead>
                <TableHead className="text-right">Processing</TableHead>
                <TableHead className="text-right">Completed</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead>Last heartbeat</TableHead>
                <TableHead>Last activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(({ agent, activity, availability }) => (
                <TableRow key={agent.agentId} data-agent-id={agent.agentId}>
                  <TableCell className="max-w-56 truncate">
                    <Link
                      href={agentHref(agent.agentId)}
                      className="font-mono text-[0.7rem] font-medium underline-offset-2 hover:underline"
                    >
                      {agent.agentId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <AvailabilityBadge
                      availability={availability}
                      thresholds={thresholds}
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Link
                      href={agentHref(agent.agentId)}
                      className="underline-offset-2 hover:underline"
                      title="Show assigned items"
                    >
                      {agent.assigned}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {agent.processing > 0 ? (
                      <Link
                        href={agentHref(agent.agentId, {
                          status: ["processing"],
                        })}
                        className="underline-offset-2 hover:underline"
                        title="Show items in processing"
                      >
                        {agent.processing}
                      </Link>
                    ) : (
                      0
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {agent.completed}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      agent.failed > 0 && "text-destructive"
                    )}
                  >
                    {agent.failed}
                  </TableCell>
                  <TableCell>
                    <TimeAgo iso={agent.lastHeartbeatAt} now={now} />
                  </TableCell>
                  <TableCell>
                    <TimeAgo iso={activity} now={now} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

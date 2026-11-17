import { cn } from "cn"
import Link from "next/link"

import { tubeViewHref, type TubeViewQuery } from "@/lib/dashboard/tube-query"
import type { ItemStatus } from "@mcpocket/core/domain/schemas"
import type { StatusCounts } from "@mcpocket/core/services/statistics"

import { ITEM_STATUS_META, StatusDot } from "./item-status"

const COUNTER_STATUSES: ItemStatus[] = [
  "pending",
  "processing",
  "completed",
  "failed",
  "retry",
  "cancelled",
  "archived",
]

/**
 * Tube status counters (from `services.statistics.tube`). Each counter is a
 * link that applies its status filter (keeping the other filters); clicking
 * the active one, or "Total", clears the status filter.
 */
export function TubeCounters({
  pathname,
  query,
  counts,
}: {
  pathname: string
  query: TubeViewQuery
  counts: StatusCounts
}) {
  const tiles = [
    {
      key: "total",
      label: "Total",
      value: counts.total,
      active: query.status.length === 0,
      href: tubeViewHref(pathname, query, { status: [] }),
      status: null,
    },
    ...COUNTER_STATUSES.map((status) => {
      const only = query.status.length === 1 && query.status[0] === status
      return {
        key: status,
        label: ITEM_STATUS_META[status].label,
        value: counts[status],
        active: query.status.includes(status),
        href: tubeViewHref(pathname, query, { status: only ? [] : [status] }),
        status,
      }
    }),
  ]

  return (
    <nav
      aria-label="Status counters"
      className="grid grid-cols-2 gap-px bg-border ring-1 ring-border sm:grid-cols-4 lg:grid-cols-8"
    >
      {tiles.map((tile) => (
        <Link
          key={tile.key}
          href={tile.href}
          scroll={false}
          aria-current={tile.active ? "true" : undefined}
          data-testid={`counter-${tile.key}`}
          className={cn(
            "flex flex-col gap-1 bg-card px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            tile.active &&
              "bg-muted shadow-[inset_0_-2px_0_var(--color-primary)]"
          )}
        >
          <span className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
            {tile.status && <StatusDot status={tile.status} />}
            {tile.label}
          </span>
          <span className="text-xl font-semibold tabular-nums">
            {tile.value}
          </span>
        </Link>
      ))}
    </nav>
  )
}

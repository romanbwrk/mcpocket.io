"use client"

import { ArrowRightIcon } from "lucide-react"

import { historyDiff, previewJson } from "@/lib/dashboard/history-diff"
import type { HistoryEvent } from "@mcpocket/core/domain/schemas"

import { JsonView } from "./json-editor"
import { UtcTime } from "./utc-time"

const ACTION_TONE: Record<string, string> = {
  created: "bg-sky-500",
  updated: "bg-zinc-400",
  status_changed: "bg-violet-500",
  claimed: "bg-amber-500",
  heartbeat: "bg-amber-300",
  completed: "bg-emerald-500",
  failed: "bg-red-500",
  released: "bg-orange-400",
  lease_expired: "bg-orange-600",
  reassigned: "bg-indigo-500",
  deleted: "bg-red-700",
  reset: "bg-teal-500",
}

function Value({ value }: { value: unknown }) {
  const full = value === undefined ? "" : JSON.stringify(value, null, 2)
  return (
    <code
      className="min-w-0 truncate font-mono text-[0.7rem]"
      title={full.length > 80 ? full : undefined}
    >
      {previewJson(value, 80)}
    </code>
  )
}

/**
 * Audit trail (newest first): action, actor, timestamp and an old → new diff
 * per top-level field. `created` events carry the whole item: shown folded.
 */
export function ItemHistoryTimeline({ events }: { events: HistoryEvent[] }) {
  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground">No history.</p>
  }
  return (
    <ol
      className="relative flex flex-col gap-3 border-l pl-4"
      data-testid="item-history"
    >
      {events.map((event) => {
        const rows =
          event.action === "created"
            ? []
            : historyDiff(event.oldValue, event.newValue)
        return (
          <li key={event.id} className="relative" data-action={event.action}>
            <span
              aria-hidden
              className={`absolute top-1.5 -left-[1.3rem] size-2 rounded-full ring-2 ring-popover ${
                ACTION_TONE[event.action] ?? "bg-zinc-400"
              }`}
            />
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-medium">
                {event.action.replace("_", " ")}
              </span>
              <span className="text-muted-foreground">by</span>
              <code className="font-mono text-[0.7rem]">{event.actor}</code>
              <span className="ml-auto text-muted-foreground">
                <UtcTime iso={event.createdAt} seconds />
              </span>
            </div>
            {event.action === "created" ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-muted-foreground select-none">
                  Initial item
                </summary>
                <JsonView value={event.newValue} className="mt-1" />
              </details>
            ) : rows.length > 0 ? (
              <ul className="mt-1 flex flex-col gap-0.5">
                {rows.map((row) => (
                  <li
                    key={row.field}
                    className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5"
                  >
                    <span className="text-muted-foreground">
                      {row.field || "value"}
                    </span>
                    <span className="flex min-w-0 text-red-700/80 line-through decoration-red-700/40 dark:text-red-300/80">
                      <Value value={row.oldValue} />
                    </span>
                    <ArrowRightIcon className="size-3 text-muted-foreground" />
                    <span className="flex min-w-0 text-emerald-700 dark:text-emerald-300">
                      <Value value={row.newValue} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

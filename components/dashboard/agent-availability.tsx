"use client"

import * as React from "react"

import { Badge } from "@/components/ui/badge"
import {
  agentAvailability,
  formatDuration,
  type AgentAvailability,
  type AvailabilityThresholds,
} from "@mcpocket/core/domain/agent-availability"
import { cn } from "@/lib/utils"

export const AVAILABILITY_META: Record<
  AgentAvailability,
  { label: string; dot: string; hint: (t: AvailabilityThresholds) => string }
> = {
  online: {
    label: "Online",
    dot: "bg-emerald-500",
    hint: (t) => `Active within the last ${formatDuration(t.onlineSeconds)}`,
  },
  idle: {
    label: "Idle",
    dot: "bg-amber-500",
    hint: (t) =>
      `Last active ${formatDuration(t.onlineSeconds)}–${formatDuration(t.staleSeconds)} ago`,
  },
  stale: {
    label: "Stale",
    dot: "bg-zinc-400 dark:bg-zinc-500",
    hint: (t) =>
      `No activity for over ${formatDuration(t.staleSeconds)} (or never seen)`,
  },
}

/** How often availability / relative ages re-evaluate without server events. */
export const NOW_TICK_MS = 5_000

/*
 * Shared ticking clock (useSyncExternalStore). The server snapshot is the
 * render time the page passes down, so hydration matches; afterwards the
 * client clock takes over and ticks every NOW_TICK_MS — an agent that stops
 * sending heartbeats turns idle → stale with no server event at all.
 */
let current = 0
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!timer) {
    current = Date.now()
    timer = setInterval(() => {
      current = Date.now()
      listeners.forEach((l) => l())
    }, NOW_TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/** Current time (ms), ticking; `serverNow` (ISO) during SSR / hydration. */
export function useNow(serverNow: string): number {
  const serverMs = Date.parse(serverNow)
  return React.useSyncExternalStore(
    subscribe,
    () => current || serverMs,
    () => serverMs
  )
}

export function AvailabilityDot({
  availability,
  className,
}: {
  availability: AgentAvailability
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-1.5 shrink-0 rounded-full",
        AVAILABILITY_META[availability].dot,
        className
      )}
    >
      {availability === "online" && (
        <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500 opacity-60" />
      )}
    </span>
  )
}

export function AvailabilityBadge({
  availability,
  thresholds,
}: {
  availability: AgentAvailability
  thresholds: AvailabilityThresholds
}) {
  const meta = AVAILABILITY_META[availability]
  return (
    <Badge
      variant="outline"
      className="gap-1.5"
      title={meta.hint(thresholds)}
      data-availability={availability}
    >
      <AvailabilityDot availability={availability} />
      {meta.label}
    </Badge>
  )
}

/** Live availability badge for one agent (re-evaluated on the ticking clock). */
export function LiveAvailabilityBadge({
  lastActivity,
  thresholds,
  serverNow,
}: {
  lastActivity: string | null
  thresholds: AvailabilityThresholds
  serverNow: string
}) {
  const now = useNow(serverNow)
  return (
    <AvailabilityBadge
      availability={agentAvailability(lastActivity, now, thresholds)}
      thresholds={thresholds}
    />
  )
}

/** "12s ago" / "3m 5s ago" (ISO in the tooltip), or "never". */
export function TimeAgo({ iso, now }: { iso: string | null; now: number }) {
  if (!iso) return <span className="text-muted-foreground">never</span>
  const seconds = Math.max(0, now - Date.parse(iso)) / 1000
  return (
    <time dateTime={iso} title={iso} className="whitespace-nowrap tabular-nums">
      {formatDuration(seconds)} ago
    </time>
  )
}

export function LiveTimeAgo({
  iso,
  serverNow,
}: {
  iso: string | null
  serverNow: string
}) {
  const now = useNow(serverNow)
  return <TimeAgo iso={iso} now={now} />
}

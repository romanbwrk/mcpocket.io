"use client"

import { usePathname, useRouter } from "next/navigation"
import * as React from "react"

import { cn } from "@/lib/utils"
import {
  DASHBOARD_EVENTS_PATH,
  eventScopeSearch,
  SSE_DOMAIN_EVENT,
  SSE_READY_EVENT,
  type DomainEvent,
  type EventScope,
} from "@mcpocket/core/events/types"

/**
 * Live dashboard: ONE EventSource per tab (opened by the dashboard shell)
 * on `/api/dashboard/events`, scoped by the current route — the tube on
 * `/dashboard/tubes/<id>`, global elsewhere. Every received event triggers a
 * debounced `router.refresh()`, which re-renders the server components (tube
 * counters + rows, inspector, folder tree in the layout) while keeping client
 * state (URL filters, open inspector, unsaved edits).
 *
 * Reconnects: the browser retries on its own (server sends `retry:`); if the
 * stream is closed for good (e.g. 401 / server restart mid-handshake) we
 * reconnect with backoff. After any outage the next `ready` triggers a
 * refresh, so missed events are caught up.
 */

export type LiveStatus = "connecting" | "live" | "reconnecting"
type LiveListener = (event: DomainEvent) => void

const LiveContext = React.createContext<{
  status: LiveStatus
  subscribe: (listener: LiveListener) => () => void
} | null>(null)

/** Debounce window coalescing bursts of events into one refresh. */
export const LIVE_REFRESH_DEBOUNCE_MS = 400
const MAX_BACKOFF_MS = 30_000

const TUBE_PATH = /^\/dashboard\/tubes\/([0-9a-f-]{36})(?:\/|$)/i

export function eventScopeForPath(pathname: string): EventScope {
  const tube = TUBE_PATH.exec(pathname)
  return tube ? { kind: "tube", tubeId: tube[1] } : { kind: "global" }
}

export function LiveUpdatesProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const search = eventScopeSearch(eventScopeForPath(pathname))
  const [status, setStatus] = React.useState<LiveStatus>("connecting")
  const listeners = React.useRef(new Set<LiveListener>())

  React.useEffect(() => {
    let source: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    let interrupted = false

    const scheduleRefresh = () => {
      if (refreshTimer) return
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        React.startTransition(() => router.refresh())
      }, LIVE_REFRESH_DEBOUNCE_MS)
    }

    const connect = () => {
      source = new EventSource(`${DASHBOARD_EVENTS_PATH}${search}`)
      source.addEventListener(SSE_READY_EVENT, () => {
        attempt = 0
        setStatus("live")
        if (interrupted) {
          interrupted = false
          scheduleRefresh() // catch up on whatever happened while offline
        }
      })
      source.addEventListener(SSE_DOMAIN_EVENT, (message) => {
        let event: DomainEvent
        try {
          event = JSON.parse((message as MessageEvent<string>).data)
        } catch {
          return
        }
        for (const listener of listeners.current) listener(event)
        scheduleRefresh()
      })
      source.onerror = () => {
        interrupted = true
        setStatus("reconnecting")
        if (source?.readyState === EventSource.CLOSED) {
          source.close()
          const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt++)
          retryTimer = setTimeout(connect, delay)
        }
        // otherwise (CONNECTING) the browser reconnects by itself
      }
    }

    connect()
    return () => {
      source?.close()
      clearTimeout(retryTimer)
      clearTimeout(refreshTimer)
      setStatus("connecting")
    }
  }, [search, router])

  const value = React.useMemo(
    () => ({
      status,
      subscribe: (listener: LiveListener) => {
        listeners.current.add(listener)
        return () => {
          listeners.current.delete(listener)
        }
      },
    }),
    [status]
  )
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

export function useLiveStatus(): LiveStatus {
  return React.useContext(LiveContext)?.status ?? "connecting"
}

/**
 * Calls `handler` for every live event of the current scope (in addition
 * to the automatic refresh). The latest `handler` is always used.
 */
export function useLiveEvent(handler: LiveListener): void {
  const subscribe = React.useContext(LiveContext)?.subscribe
  const ref = React.useRef(handler)
  React.useEffect(() => {
    ref.current = handler
  })
  React.useEffect(() => subscribe?.((event) => ref.current(event)), [subscribe])
}

const STATUS_LABEL: Record<LiveStatus, string> = {
  live: "Live",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
}

export function LiveIndicator({ className }: { className?: string }) {
  const status = useLiveStatus()
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground",
        className
      )}
      role="status"
      aria-live="polite"
      data-testid="live-status"
      data-status={status}
      title={
        status === "live"
          ? "Receiving real-time updates"
          : "Real-time updates paused — reconnecting"
      }
    >
      <span
        className={cn(
          "size-2 rounded-full",
          status === "live"
            ? "bg-emerald-500"
            : status === "reconnecting"
              ? "animate-pulse bg-amber-500"
              : "bg-muted-foreground/40"
        )}
        aria-hidden
      />
      {STATUS_LABEL[status]}
    </span>
  )
}

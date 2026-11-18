"use client"

import { Loader2Icon } from "lucide-react"
import Link from "next/link"
import * as React from "react"

import { loadPreviewItemsAction } from "@/app/dashboard/tubes/[id]/preview/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { ErrorInfo } from "@mcpocket/core/services/errors"
import type { PageResult } from "@mcpocket/core/domain/pagination"
import type { Item } from "@mcpocket/core/domain/schemas"

import { ActionError } from "./action-error"
import { CopyButton } from "./copy-block"
import { ItemStatusBadge } from "./item-status"
import { JsonView } from "./json-editor"
import { UtcTime } from "./utc-time"

/**
 * Infinite-scroll feed of the tube preview tab: every item as a card with its
 * payload, result, metadata and last error fully expanded. The first batch is
 * rendered on the server; more batches load (server action) when the sentinel
 * below the last card scrolls into view. The page keys this component by the
 * filter query, so a filter change starts a fresh feed.
 */
export function ItemPreviewList({
  tubeId,
  search,
  initial,
}: {
  tubeId: string
  /** Filter query string of the view (no `?`). */
  search: string
  initial: PageResult<Item>
}) {
  const [items, setItems] = React.useState(initial.data)
  const [total, setTotal] = React.useState(initial.page.total)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<ErrorInfo | null>(null)
  const sentinelRef = React.useRef<HTMLDivElement>(null)
  const loadingRef = React.useRef(false)

  const hasMore = items.length < total

  const loadMore = React.useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    setError(null)
    const result = await loadPreviewItemsAction(tubeId, search, items.length)
    if (result.ok) {
      setItems((prev) => {
        // Items can shift between batches (new pushes, status changes): dedupe.
        const seen = new Set(prev.map((i) => i.id))
        return [...prev, ...result.data.data.filter((i) => !seen.has(i.id))]
      })
      // An empty batch means the list shrank: stop asking for more.
      setTotal(
        result.data.data.length === 0 ? items.length : result.data.page.total
      )
    } else {
      setError(result.error)
    }
    loadingRef.current = false
    setLoading(false)
  }, [tubeId, search, items.length])

  React.useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore || error) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore()
      },
      { rootMargin: "600px 0px" }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, error, loadMore])

  return (
    <div className="flex flex-col gap-3">
      <p
        className="text-xs text-muted-foreground tabular-nums"
        data-testid="preview-count"
      >
        Showing {items.length} of {total} items
      </p>

      <ol className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.id}>
            <ItemPreviewCard tubeId={tubeId} item={item} />
          </li>
        ))}
      </ol>

      <div ref={sentinelRef} className="flex flex-col items-center gap-2 py-4">
        {error && <ActionError error={error} />}
        {loading ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading more items…
          </span>
        ) : hasMore ? (
          <Button size="sm" variant="outline" onClick={() => void loadMore()}>
            {error ? "Retry" : "Load more"}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            End of list · {total} items
          </span>
        )}
      </div>
    </div>
  )
}

function ItemPreviewCard({ tubeId, item }: { tubeId: string; item: Item }) {
  const hasMetadata = Object.keys(item.metadata).length > 0
  const hasResult = item.result !== undefined
  const error = item.lastError

  return (
    <article
      className="flex flex-col gap-3 border bg-card p-3"
      data-item-id={item.id}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <span className="flex items-center gap-0.5">
          <Link
            href={`/dashboard/tubes/${tubeId}?item=${item.id}`}
            className="font-mono text-[0.7rem] underline-offset-2 hover:underline"
            title={`Open ${item.id} in the inspector`}
          >
            {item.id}
          </Link>
          <CopyButton value={item.id} label="Copy item id" />
        </span>
        <ItemStatusBadge status={item.status} />
        <Meta label="Priority">{item.priority}</Meta>
        <Meta label="Attempts">{item.attempts}</Meta>
        {item.assignedAgent && <Meta label="Agent">{item.assignedAgent}</Meta>}
        <Meta label="Created">
          <UtcTime iso={item.createdAt} seconds />
        </Meta>
        <Meta label="Updated">
          <UtcTime iso={item.updatedAt} seconds />
        </Meta>
        {item.tags.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {item.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </span>
        )}
      </header>

      <div
        className={
          hasResult ? "grid gap-3 lg:grid-cols-2" : "flex flex-col gap-3"
        }
      >
        <JsonBlock title="Payload" value={item.payload} />
        {hasResult && <JsonBlock title="Result" value={item.result} />}
      </div>

      {hasMetadata && <JsonBlock title="Metadata" value={item.metadata} />}

      {error && (
        <div className="flex flex-col gap-2 border border-destructive/30 bg-destructive/5 p-2.5">
          <p className="text-xs">
            <span className="font-medium text-destructive">Last error</span>
            {error.code && (
              <span className="ml-2 font-mono text-[0.7rem]">{error.code}</span>
            )}
            <span className="ml-2">{error.message}</span>
          </p>
          <p className="text-[0.7rem] text-muted-foreground">
            attempt {error.attempt}
            {error.agentId && <> · agent {error.agentId}</>} ·{" "}
            <UtcTime iso={error.at} seconds />
          </p>
          {error.details !== undefined && (
            <JsonView value={error.details} className="max-h-none" />
          )}
        </div>
      )}
    </article>
  )
}

function Meta({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <span className="flex items-center gap-1 tabular-nums">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </span>
  )
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between">
        <h3 className="text-[0.7rem] font-medium text-muted-foreground">
          {title}
        </h3>
        <CopyButton
          value={JSON.stringify(value, null, 2)}
          label={`Copy ${title.toLowerCase()} JSON`}
        />
      </div>
      <JsonView value={value} className="max-h-none" />
    </section>
  )
}

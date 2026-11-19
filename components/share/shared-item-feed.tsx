"use client"

import { Loader2Icon } from "lucide-react"
import * as React from "react"

import { loadSharedItemsAction } from "@/app/share/actions"
import { ActionError } from "@/components/dashboard/action-error"
import { Button } from "@/components/ui/button"
import type {
  ShareFeedQuery,
  SharedItem,
  SharedItemsPage,
} from "@/lib/share/types"
import type { ErrorInfo } from "@mcpocket/core/services/errors"

import { SharedItemCard } from "./shared-item-card"

/**
 * Infinite-scroll feed of a shared tube. The first batch is rendered on the
 * server; more load (server action, re-authenticated with the page's key)
 * when the sentinel below the last card nears the viewport. The page keys
 * this component by the query, so a filter change starts a fresh feed.
 */
export function SharedItemFeed({
  secret,
  tubeId,
  query,
  initial,
}: {
  secret: string
  tubeId: string
  query: ShareFeedQuery
  initial: SharedItemsPage
}) {
  const [items, setItems] = React.useState<SharedItem[]>(initial.items)
  const [total, setTotal] = React.useState(initial.total)
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
    const result = await loadSharedItemsAction(
      secret,
      tubeId,
      query,
      items.length
    )
    if (result.ok) {
      setItems((prev) => {
        // Items can shift between batches (new pushes): dedupe.
        const seen = new Set(prev.map((i) => i.id))
        return [...prev, ...result.data.items.filter((i) => !seen.has(i.id))]
      })
      // An empty batch means the list shrank: stop asking for more.
      setTotal(
        result.data.items.length === 0 ? items.length : result.data.total
      )
    } else {
      setError(result.error)
    }
    loadingRef.current = false
    setLoading(false)
  }, [secret, tubeId, query, items.length])

  React.useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore || error) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore()
      },
      { rootMargin: "800px 0px" }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, error, loadMore])

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-4">
        {items.map((item) => (
          <li key={item.id}>
            <SharedItemCard item={item} />
          </li>
        ))}
      </ol>

      <div ref={sentinelRef} className="flex flex-col items-center gap-2 py-4">
        {error && <ActionError error={error} />}
        {loading ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading more…
          </span>
        ) : hasMore ? (
          <Button size="sm" variant="outline" onClick={() => void loadMore()}>
            {error ? "Retry" : "Load more"}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground tabular-nums">
            {total} {total === 1 ? "item" : "items"}
          </span>
        )}
      </div>
    </div>
  )
}

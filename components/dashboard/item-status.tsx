import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import type { ItemStatus } from "@mcpocket/core/domain/schemas"

/** Label + accent color per item status (tube counters, table, inspector). */
export const ITEM_STATUS_META: Record<
  ItemStatus,
  { label: string; dot: string }
> = {
  pending: { label: "Pending", dot: "bg-sky-500" },
  processing: { label: "Processing", dot: "bg-amber-500" },
  completed: { label: "Completed", dot: "bg-emerald-500" },
  failed: { label: "Failed", dot: "bg-red-500" },
  retry: { label: "Retry", dot: "bg-orange-500" },
  cancelled: { label: "Cancelled", dot: "bg-zinc-400" },
  archived: { label: "Archived", dot: "bg-zinc-600 dark:bg-zinc-500" },
}

export function StatusDot({
  status,
  className,
}: {
  status: ItemStatus
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        ITEM_STATUS_META[status].dot,
        className
      )}
    />
  )
}

export function ItemStatusBadge({ status }: { status: ItemStatus }) {
  return (
    <Badge variant="outline" className="gap-1.5">
      <StatusDot status={status} />
      {ITEM_STATUS_META[status].label}
    </Badge>
  )
}

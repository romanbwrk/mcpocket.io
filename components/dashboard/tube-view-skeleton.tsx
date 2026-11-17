import { Skeleton } from "@/components/ui/skeleton"

export function CountersSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-px bg-border ring-1 ring-border sm:grid-cols-4 lg:grid-cols-8">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 bg-card px-3 py-2.5">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-6 w-8" />
        </div>
      ))}
    </div>
  )
}

export function ItemTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div
      className="flex flex-col gap-2"
      role="status"
      aria-label="Loading items"
    >
      <div className="flex flex-col border bg-card">
        <div className="flex gap-4 border-b px-2 py-2.5">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-3 flex-1" />
          ))}
        </div>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex gap-4 border-b px-2 py-3 last:border-0">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>
      <Skeleton className="h-4 w-40" />
    </div>
  )
}

/** Route-level loading UI (app/dashboard/tubes/[id]/loading.tsx). */
export function TubeViewSkeleton() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-6 w-64" />
      </div>
      <CountersSkeleton />
      <Skeleton className="h-10 w-full" />
      <ItemTableSkeleton />
    </div>
  )
}

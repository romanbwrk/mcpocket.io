import { ItemTableSkeleton } from "@/components/dashboard/tube-view-skeleton"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-3 w-96 max-w-full" />
      </div>
      <Skeleton className="h-16 w-full" />
      <ItemTableSkeleton rows={5} />
    </div>
  )
}

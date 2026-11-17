import { PackageOpenIcon } from "lucide-react"

import { BRAND } from "@/lib/brand"
import { cn } from "@/lib/utils"

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center bg-primary text-primary-foreground",
        className
      )}
    >
      <PackageOpenIcon className="size-4" />
    </span>
  )
}

export function BrandLogo({
  showTagline = false,
  className,
}: {
  showTagline?: boolean
  className?: string
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <BrandMark />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm font-semibold tracking-tight">
          {BRAND.name}
        </span>
        {showTagline && (
          <span className="truncate text-[0.65rem] text-muted-foreground">
            {BRAND.tagline}
          </span>
        )}
      </span>
    </span>
  )
}

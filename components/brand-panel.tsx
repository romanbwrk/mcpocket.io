import { CheckIcon } from "lucide-react"

import { BrandLogo } from "@/components/brand"
import { BRAND } from "@/lib/brand"

/** Product name, tagline, positioning and core capabilities (plan §0). */
export function BrandPanel({ showLogo = true }: { showLogo?: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      {showLogo && <BrandLogo />}
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-balance md:text-3xl">
          {BRAND.tagline}
        </h1>
        <p className="text-sm text-muted-foreground">{BRAND.positioning}</p>
      </div>
      <ul className="grid gap-2 text-xs">
        {BRAND.capabilities.map((capability) => (
          <li key={capability} className="flex items-center gap-2">
            <CheckIcon className="size-3.5 text-primary" />
            {capability}
          </li>
        ))}
      </ul>
    </div>
  )
}

"use client"

import { useRouter } from "next/navigation"
import * as React from "react"

import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  PAGE_SIZES,
  tubeViewHref,
  type TubeViewQuery,
} from "@/lib/dashboard/tube-query"

/** Rows-per-page picker; changes `?limit=` and resets to page 1. */
export function PageSizeSelect({
  pathname,
  query,
}: {
  pathname: string
  query: TubeViewQuery
}) {
  const router = useRouter()
  const [, startTransition] = React.useTransition()
  return (
    <NativeSelect
      size="sm"
      name="limit"
      aria-label="Rows per page"
      value={query.limit}
      onChange={(e) =>
        startTransition(() =>
          router.push(
            tubeViewHref(pathname, query, { limit: Number(e.target.value) }),
            { scroll: false }
          )
        )
      }
    >
      {PAGE_SIZES.map((size) => (
        <NativeSelectOption key={size} value={size}>
          {size} / page
        </NativeSelectOption>
      ))}
    </NativeSelect>
  )
}

"use client"

import { useRouter } from "next/navigation"
import * as React from "react"

import { TableRow } from "@/components/ui/table"

/**
 * Table row that opens the item inspector (`href` = tube view URL with
 * `?item=<id>`). The ID cell holds a real link for keyboard / new-tab use;
 * clicks elsewhere on the row navigate too.
 */
export function ItemRow({
  href,
  itemId,
  selected,
  children,
}: {
  href: string
  itemId: string
  selected: boolean
  children: React.ReactNode
}) {
  const router = useRouter()
  return (
    <TableRow
      data-item-id={itemId}
      data-state={selected ? "selected" : undefined}
      className="cursor-pointer"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button")) return
        if (window.getSelection()?.toString()) return // text selection
        router.push(href, { scroll: false })
      }}
    >
      {children}
    </TableRow>
  )
}

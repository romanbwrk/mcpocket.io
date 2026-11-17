import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { tubeViewHref, type TubeViewQuery } from "@/lib/dashboard/tube-query"
import type { PageResult } from "@mcpocket/core/domain/pagination"
import type { Item } from "@mcpocket/core/domain/schemas"

import { ItemRow } from "./item-row"
import { ItemStatusBadge } from "./item-status"
import { PageSizeSelect } from "./page-size-select"
import { UtcTime } from "./utc-time"

const MAX_TAGS = 3

/**
 * Paginated item table of the tube view. Rows carry `data-item-id`; clicking
 * a row (or its ID link) opens the item inspector via `?item=<id>`.
 */
export function ItemTable({
  pathname,
  query,
  page,
}: {
  pathname: string
  query: TubeViewQuery
  page: PageResult<Item>
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Priority</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead className="text-right">Attempts</TableHead>
              <TableHead>Created (UTC)</TableHead>
              <TableHead>Updated (UTC)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.data.map((item) => (
              <ItemRow
                key={item.id}
                itemId={item.id}
                selected={query.item === item.id}
                href={tubeViewHref(pathname, query, { item: item.id })}
              >
                <TableCell>
                  <Link
                    href={tubeViewHref(pathname, query, { item: item.id })}
                    scroll={false}
                    className="font-mono text-[0.7rem] underline-offset-2 hover:underline"
                    title={`Inspect ${item.id}`}
                  >
                    {item.id.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell>
                  <ItemStatusBadge status={item.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.priority}
                </TableCell>
                <TableCell>
                  <div className="flex max-w-56 gap-1">
                    {item.tags.slice(0, MAX_TAGS).map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                    {item.tags.length > MAX_TAGS && (
                      <Badge variant="outline" title={item.tags.join(", ")}>
                        +{item.tags.length - MAX_TAGS}
                      </Badge>
                    )}
                    {item.tags.length === 0 && (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="max-w-40 truncate">
                  {item.assignedAgent ?? (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.attempts}
                </TableCell>
                <TableCell>
                  <UtcTime iso={item.createdAt} />
                </TableCell>
                <TableCell>
                  <UtcTime iso={item.updatedAt} />
                </TableCell>
              </ItemRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Pagination pathname={pathname} query={query} page={page} />
    </div>
  )
}

function Pagination({
  pathname,
  query,
  page,
}: {
  pathname: string
  query: TubeViewQuery
  page: PageResult<Item>
}) {
  const { offset, limit, total } = page.page
  const pages = Math.max(1, Math.ceil(total / limit))
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(offset + page.data.length, total)
  const prev = query.page > 1 ? Math.min(query.page - 1, pages) : null
  const next = query.page < pages ? query.page + 1 : null

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span className="tabular-nums" data-testid="page-range">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-2">
        <PageSizeSelect pathname={pathname} query={query} />
        <span className="tabular-nums">
          Page {Math.min(query.page, pages)} / {pages}
        </span>
        <PageLink
          href={
            prev === null ? null : tubeViewHref(pathname, query, { page: prev })
          }
          label="Previous page"
        >
          <ChevronLeftIcon />
        </PageLink>
        <PageLink
          href={
            next === null ? null : tubeViewHref(pathname, query, { page: next })
          }
          label="Next page"
        >
          <ChevronRightIcon />
        </PageLink>
      </div>
    </div>
  )
}

function PageLink({
  href,
  label,
  children,
}: {
  href: string | null
  label: string
  children: React.ReactNode
}) {
  if (!href) {
    return (
      <Button size="icon-sm" variant="outline" disabled aria-label={label}>
        {children}
      </Button>
    )
  }
  return (
    <Button
      size="icon-sm"
      variant="outline"
      aria-label={label}
      render={<Link href={href} scroll={false} />}
      nativeButton={false}
    >
      {children}
    </Button>
  )
}

import { ChevronRightIcon, InboxIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { StatusDot } from "@/components/dashboard/item-status"
import { ShareDenied } from "@/components/share/share-denied"
import { SharedItemFeed } from "@/components/share/shared-item-feed"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  loadSharedItems,
  parseFeedQuery,
  shareAccess,
  shareHref,
  visibleFolderPath,
} from "@/lib/share/server"
import { cn } from "@/lib/utils"
import { NotFoundError } from "@mcpocket/core/domain/errors"
import { ITEM_STATUSES } from "@mcpocket/core/domain/schemas"
import { API_KEY_QUERY_PARAM } from "@mcpocket/core/api/auth"

export async function generateMetadata({
  params,
  searchParams,
}: PageProps<"/share/tubes/[id]">): Promise<Metadata> {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const access = await shareAccess(query[API_KEY_QUERY_PARAM])
  if (!access.ok) return { title: "Shared tube" }
  const tube = await access.services.tubes.get(id).catch(() => null)
  return { title: tube?.name ?? "Shared tube" }
}

/**
 * Public view of one tube (`?api_key=` = credential): every item with its
 * fields and media, newest first, loaded in batches on scroll. `?status=`
 * and `?order=asc|desc` narrow / sort the feed.
 */
export default async function SharedTubePage({
  params,
  searchParams,
}: PageProps<"/share/tubes/[id]">) {
  const [{ id }, rawQuery] = await Promise.all([params, searchParams])
  const access = await shareAccess(rawQuery[API_KEY_QUERY_PARAM])
  if (!access.ok) return <ShareDenied reason={access.reason} />
  const { services, secret } = access

  let tube
  try {
    tube = await services.tubes.get(id)
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    throw error
  }
  const query = parseFeedQuery(rawQuery)
  const [path, stats, first] = await Promise.all([
    visibleFolderPath(services, tube.folderId),
    services.statistics.tube(tube.id).catch(() => null),
    loadSharedItems(services, tube.id, query, 0),
  ])
  const href = (patch: Partial<typeof query>) => {
    const next = { ...query, ...patch }
    return shareHref(`/share/tubes/${tube.id}`, secret, {
      status: next.status,
      order: next.order === "asc" ? "asc" : undefined,
    })
  }
  const statuses = ITEM_STATUSES.filter(
    (s) => (stats?.counts[s] ?? 0) > 0 || s === query.status
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        {path.length > 0 && (
          <nav
            aria-label="Breadcrumb"
            className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          >
            {path.map((folder) => (
              <span key={folder.id} className="flex items-center gap-1">
                <Link
                  href={shareHref(`/share/folders/${folder.id}`, secret)}
                  className="underline-offset-2 hover:underline"
                >
                  {folder.name}
                </Link>
                <ChevronRightIcon className="size-3" />
              </span>
            ))}
          </nav>
        )}
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <InboxIcon className="size-5 text-muted-foreground" />
          {tube.name}
        </h1>
        {tube.description && (
          <p className="text-xs text-muted-foreground">{tube.description}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <FilterChip href={href({ status: undefined })} active={!query.status}>
          All{stats && <Count n={stats.counts.total} />}
        </FilterChip>
        {statuses.map((status) => (
          <FilterChip
            key={status}
            href={href({ status })}
            active={query.status === status}
          >
            <StatusDot status={status} />
            <span className="capitalize">{status}</span>
            {stats && <Count n={stats.counts[status]} />}
          </FilterChip>
        ))}
        <span className="ml-auto" />
        <FilterChip
          href={href({ order: query.order === "desc" ? "asc" : "desc" })}
          active={false}
        >
          {query.order === "desc" ? "Newest first" : "Oldest first"}
        </FilterChip>
      </div>

      {first.items.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>No items</EmptyTitle>
            <EmptyDescription>
              {query.status
                ? `No ${query.status} items in this tube.`
                : "This tube has no items yet."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <SharedItemFeed
          key={`${query.status ?? ""}:${query.order}`}
          secret={secret}
          tubeId={tube.id}
          query={query}
          initial={first}
        />
      )}
    </div>
  )
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-1.5 border px-2 py-1 transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </Link>
  )
}

const Count = ({ n }: { n: number }) => (
  <span className="tabular-nums opacity-70">{n}</span>
)

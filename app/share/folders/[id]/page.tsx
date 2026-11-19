import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  InboxIcon,
} from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { ShareDenied } from "@/components/share/share-denied"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { shareAccess, shareHref, visibleFolderPath } from "@/lib/share/server"
import { API_KEY_QUERY_PARAM } from "@mcpocket/core/api/auth"
import { NotFoundError } from "@mcpocket/core/domain/errors"

export async function generateMetadata({
  params,
  searchParams,
}: PageProps<"/share/folders/[id]">): Promise<Metadata> {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const access = await shareAccess(query[API_KEY_QUERY_PARAM])
  if (!access.ok) return { title: "Shared folder" }
  const folder = await access.services.folders.get(id).catch(() => null)
  return { title: folder?.name ?? "Shared folder" }
}

/**
 * Public view of a folder (`?api_key=` = credential): its subfolders and
 * tubes (with item counts), each linking to its own share page with the
 * same key.
 */
export default async function SharedFolderPage({
  params,
  searchParams,
}: PageProps<"/share/folders/[id]">) {
  const [{ id }, rawQuery] = await Promise.all([params, searchParams])
  const access = await shareAccess(rawQuery[API_KEY_QUERY_PARAM])
  if (!access.ok) return <ShareDenied reason={access.reason} />
  const { services, secret } = access

  let folder
  try {
    folder = await services.folders.get(id)
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    throw error
  }
  const [path, subfolders, tubes] = await Promise.all([
    visibleFolderPath(services, folder.parentId),
    services.folders.list({ parentId: folder.id, limit: 200 }),
    services.tubes.list({ folderId: folder.id, limit: 200, withCounts: true }),
  ])
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        {path.length > 0 && (
          <nav
            aria-label="Breadcrumb"
            className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          >
            {path.map((f) => (
              <span key={f.id} className="flex items-center gap-1">
                <Link
                  href={shareHref(`/share/folders/${f.id}`, secret)}
                  className="underline-offset-2 hover:underline"
                >
                  {f.name}
                </Link>
                <ChevronRightIcon className="size-3" />
              </span>
            ))}
          </nav>
        )}
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <FolderOpenIcon className="size-5 text-muted-foreground" />
          {folder.name}
        </h1>
        {folder.description && (
          <p className="text-xs text-muted-foreground">{folder.description}</p>
        )}
      </div>

      {subfolders.data.length === 0 && tubes.data.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderIcon />
            </EmptyMedia>
            <EmptyTitle>Empty folder</EmptyTitle>
            <EmptyDescription>
              There are no tubes or subfolders here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {[...subfolders.data].sort(byName).map((f) => (
            <li key={f.id}>
              <Link
                href={shareHref(`/share/folders/${f.id}`, secret)}
                className="flex h-full items-start gap-3 border bg-card p-3 transition-colors hover:bg-muted/50"
              >
                <FolderIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{f.name}</span>
                  {f.description && (
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {f.description}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
          {[...tubes.data].sort(byName).map((tube) => {
            const total = tube.counts
              ? Object.values(tube.counts).reduce((a, b) => a + b, 0)
              : null
            return (
              <li key={tube.id}>
                <Link
                  href={shareHref(`/share/tubes/${tube.id}`, secret)}
                  className="flex h-full items-start gap-3 border bg-card p-3 transition-colors hover:bg-muted/50"
                >
                  <InboxIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">
                      {tube.name}
                    </span>
                    {tube.description && (
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {tube.description}
                      </span>
                    )}
                  </span>
                  {total !== null && (
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {total} {total === 1 ? "item" : "items"}
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

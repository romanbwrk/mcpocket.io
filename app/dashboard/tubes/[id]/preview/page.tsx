import { InboxIcon, SearchXIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"

import { ActionError } from "@/components/dashboard/action-error"
import { ItemFilters } from "@/components/dashboard/item-filters"
import { ItemPreviewList } from "@/components/dashboard/item-preview-list"
import { loadTube, TubeHeader } from "@/components/dashboard/tube-header"
import { ItemTableSkeleton } from "@/components/dashboard/tube-view-skeleton"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { getUserServices } from "@/lib/auth/server"
import { tubeItemsListInput } from "@/lib/dashboard/tube-items"
import {
  activeFilterCount,
  filterSearchParams,
  parseTubeViewQuery,
  PREVIEW_BATCH_SIZE,
  type TubeViewQuery,
} from "@/lib/dashboard/tube-query"
import type { Services } from "@mcpocket/core/services"
import { normalizeError } from "@mcpocket/core/services/errors"

export async function generateMetadata({
  params,
}: PageProps<"/dashboard/tubes/[id]/preview">): Promise<Metadata> {
  const { id } = await params
  const services = await getUserServices()
  const tube = await services.tubes.get(id).catch(() => null)
  return { title: tube ? `${tube.name} · Preview` : "Tube not found" }
}

/**
 * Tube → Preview tab: every item as a card with its JSON (payload, result,
 * metadata, last error) expanded, loaded in batches on scroll. Uses the same
 * URL filter format as the Items tab (`lib/dashboard/tube-query.ts`);
 * `page`/`limit` are ignored here.
 */
export default async function TubePreviewPage({
  params,
  searchParams,
}: PageProps<"/dashboard/tubes/[id]/preview">) {
  const [{ id }, rawQuery] = await Promise.all([params, searchParams])
  const services = await getUserServices()
  const tube = await loadTube(services, id)
  const query: TubeViewQuery = {
    ...parseTubeViewQuery(rawQuery),
    page: 1,
    item: undefined,
  }
  const pathname = `/dashboard/tubes/${tube.id}/preview`
  const search = filterSearchParams(query).toString()

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <TubeHeader services={services} tube={tube} active="preview" />

      <ItemFilters
        key={`filters?${search}`}
        pathname={pathname}
        query={query}
      />

      <Suspense key={`preview?${search}`} fallback={<ItemTableSkeleton />}>
        <PreviewSection
          services={services}
          tubeId={tube.id}
          pathname={pathname}
          query={query}
          search={search}
        />
      </Suspense>
    </div>
  )
}

async function PreviewSection({
  services,
  tubeId,
  pathname,
  query,
  search,
}: {
  services: Services
  tubeId: string
  pathname: string
  query: TubeViewQuery
  search: string
}) {
  let page
  try {
    page = await services.items.list(tubeId, {
      ...tubeItemsListInput(query),
      offset: 0,
      limit: PREVIEW_BATCH_SIZE,
    })
  } catch (error) {
    const info = normalizeError(error)
    if (info.code === "internal_error") throw error
    return (
      <div className="flex flex-col items-start gap-3">
        <ActionError error={info} />
        <Button
          size="sm"
          variant="outline"
          render={<Link href={pathname} />}
          nativeButton={false}
        >
          Clear filters
        </Button>
      </div>
    )
  }

  if (page.data.length > 0) {
    return <ItemPreviewList tubeId={tubeId} search={search} initial={page} />
  }

  const filtered = activeFilterCount(query) > 0
  return (
    <Empty className="border border-dashed" data-testid="items-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {filtered ? <SearchXIcon /> : <InboxIcon />}
        </EmptyMedia>
        <EmptyTitle>
          {filtered ? "No items match these filters" : "No items yet"}
        </EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "Try removing a filter or widening the date range."
            : "Items pushed to this tube will appear here with their full JSON."}
        </EmptyDescription>
      </EmptyHeader>
      {filtered && (
        <EmptyContent>
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<Link href={pathname} />}
          >
            Clear filters
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}

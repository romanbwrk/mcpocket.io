import { InboxIcon, SearchXIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"

import { ActionError } from "@/components/dashboard/action-error"
import { ItemFilters } from "@/components/dashboard/item-filters"
import {
  ItemInspector,
  type ItemInspectorData,
} from "@/components/dashboard/item-inspector"
import { ItemTable } from "@/components/dashboard/item-table"
import { TubeCounters } from "@/components/dashboard/tube-counters"
import { loadTube, TubeHeader } from "@/components/dashboard/tube-header"
import {
  CountersSkeleton,
  ItemTableSkeleton,
} from "@/components/dashboard/tube-view-skeleton"
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
  EMPTY_TUBE_VIEW_QUERY,
  parseTubeViewQuery,
  tubeViewHref,
  tubeViewSearch,
  type TubeViewQuery,
} from "@/lib/dashboard/tube-query"
import { NotFoundError } from "@mcpocket/core/domain/errors"
import type { Tube } from "@mcpocket/core/domain/schemas"
import type { Services } from "@mcpocket/core/services"
import { normalizeError } from "@mcpocket/core/services/errors"

export async function generateMetadata({
  params,
}: PageProps<"/dashboard/tubes/[id]">): Promise<Metadata> {
  const { id } = await params
  const services = await getUserServices()
  const tube = await services.tubes.get(id).catch(() => null)
  return { title: tube ? tube.name : "Tube not found" }
}

/**
 * Tube view: header + settings, status counters (tube statistics), filters
 * and the paginated item table. All view state lives in the URL
 * (`lib/dashboard/tube-query.ts`, REST filter format).
 */
export default async function TubePage({
  params,
  searchParams,
}: PageProps<"/dashboard/tubes/[id]">) {
  const [{ id }, rawQuery] = await Promise.all([params, searchParams])
  const services = await getUserServices()
  const tube = await loadTube(services, id)
  const query = parseTubeViewQuery(rawQuery)
  const pathname = `/dashboard/tubes/${tube.id}`
  // Suspense keys ignore `item`: opening the inspector keeps the list mounted.
  const search = tubeViewSearch(query, { withItem: false })

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <TubeHeader services={services} tube={tube} active="items" />

      <Suspense fallback={<CountersSkeleton />}>
        <TubeCountersSection
          services={services}
          tubeId={tube.id}
          pathname={pathname}
          query={query}
        />
      </Suspense>

      <ItemFilters
        key={`filters?${search}`}
        pathname={pathname}
        query={query}
      />

      <Suspense key={`items?${search}`} fallback={<ItemTableSkeleton />}>
        <TubeItemsSection
          services={services}
          tubeId={tube.id}
          pathname={pathname}
          query={query}
        />
      </Suspense>

      {query.item && (
        <Suspense key={`item:${query.item}`}>
          <ItemInspectorSection
            services={services}
            tube={tube}
            itemId={query.item}
            closeHref={tubeViewHref(pathname, query, { item: undefined })}
          />
        </Suspense>
      )}
    </div>
  )
}

/** Newest history events loaded into the inspector. */
const INSPECTOR_HISTORY_LIMIT = 100

async function ItemInspectorSection({
  services,
  tube,
  itemId,
  closeHref,
}: {
  services: Services
  tube: Tube
  itemId: string
  closeHref: string
}) {
  let data: ItemInspectorData
  try {
    const [item, history] = await Promise.all([
      services.items.get(itemId),
      services.items.history(itemId, { limit: INSPECTOR_HISTORY_LIMIT }),
    ])
    const itemTube =
      item.tubeId === tube.id ? tube : await services.tubes.get(item.tubeId)
    data = {
      found: true,
      item,
      history,
      tube: {
        id: itemTube.id,
        name: itemTube.name,
        schemaDefinition: itemTube.schemaDefinition,
      },
    }
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error
    data = { found: false, id: itemId }
  }
  return <ItemInspector data={data} closeHref={closeHref} />
}

type SectionProps = {
  services: Services
  tubeId: string
  pathname: string
  query: TubeViewQuery
}

async function TubeCountersSection({
  services,
  tubeId,
  pathname,
  query,
}: SectionProps) {
  const stats = await services.statistics.tube(tubeId)
  return (
    <TubeCounters pathname={pathname} query={query} counts={stats.counts} />
  )
}

async function TubeItemsSection({
  services,
  tubeId,
  pathname,
  query,
}: SectionProps) {
  const clearHref = tubeViewHref(pathname, {
    ...EMPTY_TUBE_VIEW_QUERY,
    limit: query.limit,
  })
  let page
  try {
    page = await services.items.list(tubeId, tubeItemsListInput(query))
  } catch (error) {
    const info = normalizeError(error)
    if (info.code === "internal_error") throw error
    return (
      <div className="flex flex-col items-start gap-3">
        <ActionError error={info} />
        <Button
          size="sm"
          variant="outline"
          render={<Link href={clearHref} />}
          nativeButton={false}
        >
          Clear filters
        </Button>
      </div>
    )
  }

  if (page.data.length > 0) {
    return <ItemTable pathname={pathname} query={query} page={page} />
  }

  const filtered = activeFilterCount(query) > 0
  const outOfRange = page.page.total > 0
  return (
    <Empty className="border border-dashed" data-testid="items-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {filtered || outOfRange ? <SearchXIcon /> : <InboxIcon />}
        </EmptyMedia>
        <EmptyTitle>
          {outOfRange
            ? "No items on this page"
            : filtered
              ? "No items match these filters"
              : "No items yet"}
        </EmptyTitle>
        <EmptyDescription>
          {outOfRange ? (
            `This view has ${page.page.total} items, but none on page ${query.page}.`
          ) : filtered ? (
            "Try removing a filter or widening the date range."
          ) : (
            <>
              Use <strong>Import</strong> to add items from JSON, or push them
              with <code>POST /api/tubes/{tubeId}/items</code> or the{" "}
              <code>push_item</code> MCP tool.
            </>
          )}
        </EmptyDescription>
      </EmptyHeader>
      {(filtered || outOfRange) && (
        <EmptyContent>
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={
              <Link
                href={
                  outOfRange
                    ? tubeViewHref(pathname, query, { page: 1 })
                    : clearHref
                }
              />
            }
          >
            {outOfRange ? "Go to first page" : "Clear filters"}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}

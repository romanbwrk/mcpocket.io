import { ImageIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { MediaLibrary } from "@/components/dashboard/media-library"
import { loadTube, TubeHeader } from "@/components/dashboard/tube-header"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { getUserServices } from "@/lib/auth/server"
import { MEDIA_PAGE_SIZE, parseMediaQuery } from "@/lib/dashboard/media"
import { normalizeError } from "@mcpocket/core/services/errors"

export async function generateMetadata({
  params,
}: PageProps<"/dashboard/tubes/[id]/media">): Promise<Metadata> {
  const { id } = await params
  const services = await getUserServices()
  const tube = await services.tubes.get(id).catch(() => null)
  return { title: tube ? `${tube.name} · Media` : "Tube not found" }
}

/**
 * Tube → Media tab: the stored files (S3) referenced by this tube's items
 * (payload, metadata or result), with previews, kind filters and the items
 * that use each file. Same gallery as the global Media page.
 */
export default async function TubeMediaPage({
  params,
  searchParams,
}: PageProps<"/dashboard/tubes/[id]/media">) {
  const [{ id }, rawQuery] = await Promise.all([params, searchParams])
  const services = await getUserServices()
  const tube = await loadTube(services, id)
  const query = parseMediaQuery(rawQuery)

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <TubeHeader services={services} tube={tube} active="media" />
      <TubeMedia services={services} tubeId={tube.id} query={query} />
    </div>
  )
}

async function TubeMedia({
  services,
  tubeId,
  query,
}: {
  services: Awaited<ReturnType<typeof getUserServices>>
  tubeId: string
  query: ReturnType<typeof parseMediaQuery>
}) {
  if (!services.media.status().enabled) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ImageIcon />
          </EmptyMedia>
          <EmptyTitle>Media storage is not configured</EmptyTitle>
          <EmptyDescription>
            Set <code>MCPOCKET_S3_BUCKET</code> in <code>.env</code> and
            restart. See the <Link href="/dashboard/media">Media</Link> page.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  let result
  try {
    result = await services.media.list({
      tubeId,
      ...(query.kind && { kind: query.kind }),
      offset: (query.page - 1) * MEDIA_PAGE_SIZE,
      limit: MEDIA_PAGE_SIZE,
    })
  } catch (error) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Could not read the media store</EmptyTitle>
          <EmptyDescription className="break-all">
            {normalizeError(error).message}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <>
      <p className="text-xs text-muted-foreground">
        Files referenced by this tube&apos;s items (payload, metadata or
        result). Counts on each file are items of this tube; open a file to see
        every item that uses it.
      </p>
      <MediaLibrary result={result} query={query} tubeId={tubeId} />
    </>
  )
}

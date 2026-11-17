import { ImageIcon } from "lucide-react"

import { MediaLibrary } from "@/components/dashboard/media-library"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { getUserServices } from "@/lib/auth/server"
import { MEDIA_PAGE_SIZE, parseMediaQuery } from "@/lib/dashboard/media"
import { formatBytes } from "@mcpocket/core/media/kinds"
import { normalizeError } from "@mcpocket/core/services/errors"

export const metadata = { title: "Media" }

/**
 * Media library: every file in the S3 media store (uploaded directly or
 * extracted from item data URIs) with previews, filters, usage by items,
 * upload and delete. Everything goes through `services.media`.
 */
export default async function MediaPage({
  searchParams,
}: PageProps<"/dashboard/media">) {
  const query = parseMediaQuery(await searchParams)
  const services = await getUserServices()
  const status = services.media.status()

  if (!status.enabled) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <Header />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ImageIcon />
            </EmptyMedia>
            <EmptyTitle>Media storage is not configured</EmptyTitle>
            <EmptyDescription>
              Set <code>MCPOCKET_S3_BUCKET</code> (plus endpoint, region and
              credentials for S3-compatible stores) in <code>.env</code> and
              restart. See README → Media (S3).
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  let result
  try {
    result = await services.media.list({
      ...(query.kind && { kind: query.kind }),
      ...(query.usage && { usage: query.usage }),
      offset: (query.page - 1) * MEDIA_PAGE_SIZE,
      limit: MEDIA_PAGE_SIZE,
    })
  } catch (error) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <Header />
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Could not read the media store</EmptyTitle>
            <EmptyDescription className="break-all">
              {normalizeError(error).message}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <Header>
        Files live in <code>{result.location}</code>; items keep their URLs. Max{" "}
        {formatBytes(status.maxBytes)} per file
        {status.allowedTypes.length > 0 &&
          `, types: ${status.allowedTypes.join(", ")}`}
        .
        {result.truncated && (
          <strong className="text-destructive">
            {" "}
            Only the first 10,000 objects are shown.
          </strong>
        )}
      </Header>
      <MediaLibrary result={result} query={query} />
    </div>
  )
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight">Media</h1>
      <p className="text-xs text-muted-foreground">
        Images, videos and files stored for items — uploaded here, through{" "}
        <code>POST /api/media</code>, or extracted from data URIs in item
        payloads and results. {children}
      </p>
    </div>
  )
}

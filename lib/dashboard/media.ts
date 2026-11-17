import { MEDIA_KINDS, type MediaKind } from "@mcpocket/core/media/kinds"

/** Media library page size. */
export const MEDIA_PAGE_SIZE = 48

export type MediaUsageFilter = "used" | "unused"

/** `/dashboard/media?kind=&usage=&page=` (page is 1-based). */
export type MediaQuery = {
  kind: MediaKind | null
  usage: MediaUsageFilter | null
  page: number
}

type SearchParams = Record<string, string | string[] | undefined>

const first = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v

export function parseMediaQuery(params: SearchParams): MediaQuery {
  const kind = first(params.kind)
  const usage = first(params.usage)
  const page = Number(first(params.page))
  return {
    kind: MEDIA_KINDS.includes(kind as MediaKind) ? (kind as MediaKind) : null,
    usage: usage === "used" || usage === "unused" ? usage : null,
    page: Number.isInteger(page) && page > 1 ? page : 1,
  }
}

export const MEDIA_LIBRARY_PATH = "/dashboard/media"

/**
 * Link to the library (or a tube's Media tab, `basePath`) with `changes`
 * applied; filter changes reset the page.
 */
export function mediaHref(
  query: MediaQuery,
  changes: Partial<MediaQuery>,
  basePath: string = MEDIA_LIBRARY_PATH
): string {
  const next = {
    ...query,
    ...(("kind" in changes || "usage" in changes) && { page: 1 }),
    ...changes,
  }
  const params = new URLSearchParams()
  if (next.kind) params.set("kind", next.kind)
  if (next.usage) params.set("usage", next.usage)
  if (next.page > 1) params.set("page", String(next.page))
  const qs = params.toString()
  return qs ? `${basePath}?${qs}` : basePath
}

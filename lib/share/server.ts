import "server-only"

import { headers } from "next/headers"

import { API_KEY_QUERY_PARAM, authorizeRequest } from "@mcpocket/core/api/auth"
import { roleHasCapability } from "@mcpocket/core/domain/access"
import { RateLimitedError } from "@mcpocket/core/domain/errors"
import {
  ITEM_STATUSES,
  type Folder,
  type Item,
  type ItemStatus,
} from "@mcpocket/core/domain/schemas"
import {
  contentTypeFromKey,
  mediaKind,
  type MediaKind,
} from "@mcpocket/core/media/kinds"
import { MAX_LINK_URLS } from "@mcpocket/core/services/media"
import {
  getServices,
  publicOrigin,
  type Services,
} from "@mcpocket/core/services"

import type {
  ShareFeedQuery,
  SharedItem,
  SharedItemsPage,
  SharedMedia,
} from "./types"

/**
 * Public share pages (`/share/tubes/{id}?api_key=…`, `/share/folders/{id}?api_key=…`):
 * no dashboard session, the `api_key` in the URL is the credential. It goes
 * through the same auth + rate limit + scoped services as REST, so a page
 * shows exactly what the key may read. Media URLs inside items are swapped
 * for signed links, so `<img>` / `<video>` and copied links work without the
 * key (and the key never leaks into a media request).
 */

export type ShareAccess =
  | { ok: true; services: Services; secret: string }
  | { ok: false; reason: "missing" | "invalid" | "rate_limited" }

/** Services bound to the key in `?api_key=`, or why there are none. */
export async function shareAccess(
  rawSecret: string | string[] | undefined
): Promise<ShareAccess> {
  const secret = (Array.isArray(rawSecret) ? rawSecret[0] : rawSecret)?.trim()
  if (!secret) return { ok: false, reason: "missing" }
  try {
    const { principal } = await authorizeRequest(
      new Request("http://share.local/", {
        headers: { authorization: `Bearer ${secret}` },
      })
    )
    const role = principal.actor.access?.role ?? "admin"
    if (!roleHasCapability(role, "read"))
      return { ok: false, reason: "invalid" }
    const services = await getServices(principal.actor, {
      publicUrl: publicOrigin(await headers()),
    })
    return { ok: true, services, secret }
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return { ok: false, reason: "rate_limited" }
    }
    return { ok: false, reason: "invalid" }
  }
}

/** `/share/...` path with the key (and extra params) in the query. */
export function shareHref(
  path: string,
  secret: string,
  params: Record<string, string | undefined> = {}
): string {
  const query = new URLSearchParams({ [API_KEY_QUERY_PARAM]: secret })
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value)
  }
  return `${path}?${query}`
}

export function parseFeedQuery(
  raw: Record<string, string | string[] | undefined>
): ShareFeedQuery {
  const one = (key: string) => {
    const v = raw[key]
    return Array.isArray(v) ? v[0] : v
  }
  const status = one("status")
  return {
    status: ITEM_STATUSES.includes(status as ItemStatus)
      ? (status as ItemStatus)
      : undefined,
    order: one("order") === "asc" ? "asc" : "desc",
  }
}

export const SHARE_BATCH_SIZE = 12

/** One batch of a tube's items, media links signed. */
export async function loadSharedItems(
  services: Services,
  tubeId: string,
  query: ShareFeedQuery,
  offset: number
): Promise<SharedItemsPage> {
  const page = await services.items.list(tubeId, {
    ...(query.status && { status: [query.status] }),
    order: query.order,
    offset: Math.max(0, Math.trunc(offset) || 0),
    limit: SHARE_BATCH_SIZE,
  })
  const urls = new Set<string>()
  for (const item of page.data) {
    collectUrls(item.payload, urls)
    collectUrls(item.result, urls)
    collectUrls(item.metadata, urls)
  }
  const links = await signedLinks(services, [...urls])
  return {
    items: page.data.map((item) => toSharedItem(item, links)),
    total: page.page.total,
  }
}

/** Root → folder chain the key can see (stops at the first hidden folder). */
export async function visibleFolderPath(
  services: Services,
  folderId: string | null
): Promise<Folder[]> {
  const path: Folder[] = []
  const seen = new Set<string>()
  let current = folderId
  while (current && !seen.has(current)) {
    seen.add(current)
    const folder = await services.folders.get(current).catch(() => null)
    if (!folder) break
    path.unshift(folder)
    current = folder.parentId
  }
  return path
}

const HTTP_URL = /^https?:\/\/[^\s]+$/i

function collectUrls(value: unknown, out: Set<string>) {
  if (typeof value === "string") {
    if (HTTP_URL.test(value)) out.add(value)
  } else if (Array.isArray(value)) {
    for (const v of value) collectUrls(v, out)
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectUrls(v, out)
  }
}

/**
 * Signed link per media URL of this server (private media); other URLs are
 * left out (used as is). Links expire in ~6-7 days, rounded to the hour so
 * reloads reuse the same URLs (browser cache).
 */
async function signedLinks(
  services: Services,
  urls: string[]
): Promise<Map<string, string>> {
  const links = new Map<string, string>()
  if (urls.length === 0 || !services.media.status().enabled) return links
  const nowSeconds = Math.floor(services.ctx.clock.now().getTime() / 1000)
  const expiresInSeconds = 6 * 24 * 3600 + (3600 - (nowSeconds % 3600))
  for (let i = 0; i < urls.length; i += MAX_LINK_URLS) {
    const chunk = urls.slice(i, i + MAX_LINK_URLS)
    try {
      const { results } = services.media.createLinks({
        urls: chunk,
        expiresInSeconds,
      })
      for (const r of results) {
        if (r.ok && r.data.link !== chunk[r.index]) {
          links.set(chunk[r.index], r.data.link)
        }
      }
    } catch {
      // Media misconfigured: show the permanent URLs.
    }
  }
  return links
}

function replaceUrls(value: unknown, links: Map<string, string>): unknown {
  if (links.size === 0) return value
  if (typeof value === "string") return links.get(value) ?? value
  if (Array.isArray(value)) return value.map((v) => replaceUrls(v, links))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, replaceUrls(v, links)])
    )
  }
  return value
}

const PREVIEWABLE: readonly MediaKind[] = ["image", "video", "audio"]

/** Kind of a media URL from its path extension (`null`: not a media file). */
function urlMediaKind(url: string): MediaKind | null {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  const type = contentTypeFromKey(pathname)
  if (type === "application/octet-stream") return null
  return mediaKind(type)
}

function collectMedia(
  value: unknown,
  path: string,
  out: SharedMedia[],
  seen: Set<string>
) {
  if (typeof value === "string") {
    if (!HTTP_URL.test(value) || seen.has(value)) return
    const kind = urlMediaKind(value)
    if (!kind) return
    seen.add(value)
    out.push({
      path,
      url: value,
      kind,
      previewable: PREVIEWABLE.includes(kind),
    })
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectMedia(v, `${path}[${i}]`, out, seen))
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      collectMedia(v, path ? `${path}.${k}` : k, out, seen)
    }
  }
}

function toSharedItem(item: Item, links: Map<string, string>): SharedItem {
  const payload = replaceUrls(item.payload, links)
  const result =
    item.result === undefined ? undefined : replaceUrls(item.result, links)
  const metadata = replaceUrls(item.metadata, links) as Record<string, unknown>
  const media: SharedMedia[] = []
  const seen = new Set<string>()
  // Results first: in a generation pipeline that's the produced media.
  collectMedia(result, "result", media, seen)
  collectMedia(payload, "payload", media, seen)
  collectMedia(metadata, "metadata", media, seen)
  return {
    id: item.id,
    status: item.status,
    tags: item.tags,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    payload,
    ...(result !== undefined && { result }),
    metadata,
    media,
    ...(item.lastError && { error: item.lastError.message }),
  }
}

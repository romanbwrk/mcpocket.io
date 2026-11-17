import { authorizeMediaRequest } from "@mcpocket/core/api/media-access"
import { getMediaStore } from "@mcpocket/core/media"
import { mediaAccessFromEnv } from "@mcpocket/core/media/links"
import { contentTypeFromKey } from "@mcpocket/core/media/kinds"
import { RangeNotSatisfiableError } from "@mcpocket/core/media/store"
import {
  isWorkspaceSlug,
  multiWorkspaceEnabled,
} from "@mcpocket/core/workspace"

type Params = { params: Promise<{ key: string[] }> }

/** Keys this server writes: `<prefix>ab/<sha256>.<ext>`. */
const KEY_TAIL = /^[0-9a-f]{2}\/([0-9a-f]{64})\.[a-z0-9]{1,10}$/

/** Content types a browser could run as a document on this origin. */
const ACTIVE_TYPES = new Set([
  "text/html",
  "image/svg+xml",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
])

/**
 * GET / HEAD /api/media/files/{key} — serves a media object from the
 * (private) bucket, so media links work without a CDN or a public bucket
 * (`MCPOCKET_MEDIA_DELIVERY=server`, the default).
 *
 * Access (`MCPOCKET_MEDIA_ACCESS`): `private` (default) serves a file only
 * to an API key with `read`, a dashboard session, or a signed link from
 * `create_media_link` (`?exp=&sig=`, expiring) — the way to hand a file to
 * a generator, a social network or a player that holds no API key.
 * `public` serves anyone with the link (keys are unguessable sha256
 * content hashes). Supports `Range` (video
 * seeking, resumable downloads), `If-None-Match` and long-lived caching
 * (objects never change). Uploaded documents are sandboxed (CSP) and HTML /
 * SVG are sent as attachments, so a file can never run script on this origin.
 */
async function serve(request: Request, { params }: Params, head: boolean) {
  const store = getMediaStore()
  const key = (await params).key.map(decodeURIComponent).join("/")
  const prefix = store?.limits.prefix ?? ""
  let tail = key.startsWith(prefix) ? key.slice(prefix.length) : ""
  // Multi-workspace mode: `<prefix><workspace>/ab/<sha256>.<ext>`.
  let workspace: string | undefined
  if (multiWorkspaceEnabled()) {
    const slash = tail.indexOf("/")
    const candidate = tail.slice(0, Math.max(0, slash))
    if (!isWorkspaceSlug(candidate)) return notFound()
    workspace = candidate
    tail = tail.slice(slash + 1)
  }
  const sha = KEY_TAIL.exec(tail)?.[1]
  if (!store || !sha) return notFound()

  const grant = await authorizeMediaRequest(
    request,
    key,
    mediaAccessFromEnv(),
    new Date(),
    workspace
  )
  if (!grant.ok) {
    return Response.json(
      grant.rateLimited
        ? { error: { code: "rate_limited", message: "Too many requests" } }
        : {
            error: {
              code: "unauthorized",
              message:
                "Private media: send an API key, sign in to the dashboard, or use a signed link (create_media_link)",
            },
          },
      {
        status: grant.rateLimited ? 429 : 401,
        headers: { "Cache-Control": "no-store" },
      }
    )
  }

  const etag = `"${sha}"`
  const type = contentTypeFromKey(key)
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": cacheControl(grant),
    ETag: etag,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": "*",
    // Credentialed answers depend on these; never mix them in a cache.
    Vary: "Cookie, Authorization, X-API-Key",
  })
  if (ACTIVE_TYPES.has(type)) headers.set("Content-Disposition", "attachment")

  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers })
  }

  if (head) {
    const stat = await store.stat(key)
    if (!stat) return notFound()
    headers.set("Content-Length", String(stat.size))
    return new Response(null, { status: 200, headers })
  }

  const range = request.headers.get("range") ?? undefined
  // Ignore malformed / multi-range headers: answer with the whole object.
  const validRange =
    range && /^bytes=\d*-\d*$/.test(range.trim()) ? range.trim() : undefined
  try {
    const object = await store.get(key, validRange)
    if (!object) return notFound()
    headers.set("Content-Length", String(object.length))
    if (object.contentDisposition && !headers.has("Content-Disposition")) {
      headers.set("Content-Disposition", object.contentDisposition)
    }
    if (object.contentRange) {
      headers.set("Content-Range", object.contentRange)
      return new Response(object.body, { status: 206, headers })
    }
    return new Response(object.body, { status: 200, headers })
  } catch (error) {
    if (error instanceof RangeNotSatisfiableError) {
      headers.set("Content-Range", `bytes */${error.totalSize}`)
      return new Response(null, { status: 416, headers })
    }
    throw error
  }
}

/**
 * Objects never change, but who may cache them depends on the grant:
 * public → shared caches for a year; signed → shared caches until the link
 * expires; session / API key → the requester's own cache only.
 */
function cacheControl(grant: { via: string; expires?: number }): string {
  if (grant.via === "public") return "public, max-age=31536000, immutable"
  if (grant.via === "signed" && grant.expires !== undefined) {
    const left = Math.max(0, grant.expires - Math.floor(Date.now() / 1000))
    return `public, max-age=${Math.min(left, 31536000)}`
  }
  return "private, max-age=31536000, immutable"
}

function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === etag || t === "*")
}

const notFound = () =>
  Response.json(
    { error: { code: "not_found", message: "Media not found" } },
    { status: 404 }
  )

export const GET = (request: Request, ctx: Params) => serve(request, ctx, false)
export const HEAD = (request: Request, ctx: Params) => serve(request, ctx, true)

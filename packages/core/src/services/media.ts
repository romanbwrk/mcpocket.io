import { z } from "zod"

import { apiKeysFromEnv } from "../auth/api-keys"
import { roleHasCapability, type Role } from "../domain/access"
import type { Actor } from "../domain/actor"
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../domain/errors"
import type { PageResult } from "../domain/pagination"
import { IdSchema, type Item, type ItemStatus } from "../domain/schemas"
import {
  contentTypeFromKey,
  MEDIA_KINDS,
  mediaKind,
  type MediaKind,
} from "../media/kinds"
import { isAllowedType } from "../media/config"
import {
  createMediaMaterializer,
  storeMediaFile,
  type MediaFile,
  type MediaMaterializer,
  type MediaObject,
} from "../media/materialize"
import {
  DEFAULT_MEDIA_LINK_TTL_SECONDS,
  MAX_MEDIA_LINK_TTL_SECONDS,
  mediaAccessFromEnv,
  signMediaUrl,
} from "../media/links"
import {
  MEDIA_FILES_PATH,
  type MediaStore,
  type StoredObject,
} from "../media/store"
import {
  createUploadToken,
  DEFAULT_UPLOAD_TTL_SECONDS,
  MAX_UPLOAD_TTL_SECONDS,
  uploadSigningKey,
  verifyUploadToken,
  type UploadClaims,
} from "../media/upload-token"

import { createAccessControl } from "./access"
import type { ServiceContext } from "./context"

export type MediaStatus =
  | { enabled: false }
  | {
      enabled: true
      maxBytes: number
      allowedTypes: string[]
      /** Who can open media URLs served by this server (`MCPOCKET_MEDIA_ACCESS`). */
      access: "private" | "public"
    }

const UploadMediaInputSchema = z.object({
  body: z.custom<Uint8Array>((v) => v instanceof Uint8Array, "Expected bytes"),
  contentType: z.string().trim().min(1).max(200),
  filename: z.string().trim().min(1).max(255).optional(),
})
export type UploadMediaInput = MediaFile

export const ListMediaInputSchema = z.object({
  /** Only files referenced by this tube's items (`usedBy` counts them). */
  tubeId: IdSchema.optional(),
  kind: z.enum(MEDIA_KINDS).optional(),
  /** `used`: referenced by at least one item; `unused`: by none. */
  usage: z.enum(["used", "unused"]).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(48),
})
export type ListMediaInput = z.input<typeof ListMediaInputSchema>

/** A media object in the library (newest first). */
/** Max URLs per `ingest` call. */
export const MAX_INGEST_URLS = 20

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
const UrlSchema = z.string().trim().min(1).max(8192)
const IngestEntrySchema = z.union([
  UrlSchema,
  z.strictObject({
    url: UrlSchema,
    /** Overrides the type the remote server reports. */
    contentType: z.string().trim().regex(MIME_RE).optional(),
    filename: z.string().trim().min(1).max(255).optional(),
  }),
])

export const IngestMediaInputSchema = z
  .strictObject({
    url: UrlSchema.optional(),
    urls: z.array(IngestEntrySchema).min(1).max(MAX_INGEST_URLS).optional(),
  })
  .refine((v) => (v.url === undefined) !== (v.urls === undefined), {
    message: "Pass either url or urls",
  })
export type IngestMediaInput = z.input<typeof IngestMediaInputSchema>

/** A file now held in media storage (`url` is permanent). */
export type IngestedMedia = Omit<MediaObject, "size"> & {
  /** The URL that was ingested. */
  sourceUrl: string
  /** Unknown when the URL already pointed into media storage (`reused`). */
  size?: number
  /** The URL was already a media-storage URL: nothing was fetched. */
  reused?: true
}

export type IngestResult = {
  results: Array<
    | { index: number; ok: true; data: IngestedMedia }
    | {
        index: number
        ok: false
        sourceUrl: string
        error: { code: string; message: string; details?: unknown }
      }
  >
  summary: { total: number; succeeded: number; failed: number }
}

export const CreateUploadInputSchema = z.strictObject({
  /** The upload must send exactly this Content-Type (recommended). */
  contentType: z.string().trim().regex(MIME_RE).optional(),
  filename: z.string().trim().min(1).max(255).optional(),
  expiresInSeconds: z.coerce
    .number()
    .int()
    .min(60)
    .max(MAX_UPLOAD_TTL_SECONDS)
    .default(DEFAULT_UPLOAD_TTL_SECONDS),
})
export type CreateUploadInput = z.input<typeof CreateUploadInputSchema>

export type UploadLink = {
  uploadUrl: string
  method: "PUT"
  headers: Record<string, string>
  expiresAt: string
  maxBytes: number
  allowedTypes: string[]
  /** Ready-to-run command; replace FILE with the local path. */
  curl: string
}

const OWN_KEY_RE = /^[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]{1,10}$/

/** Max URLs per `createLinks` call. */
export const MAX_LINK_URLS = 50

export const CreateMediaLinksInputSchema = z
  .strictObject({
    url: UrlSchema.optional(),
    urls: z.array(UrlSchema).min(1).max(MAX_LINK_URLS).optional(),
    expiresInSeconds: z.coerce
      .number()
      .int()
      .min(60)
      .max(MAX_MEDIA_LINK_TTL_SECONDS)
      .default(DEFAULT_MEDIA_LINK_TTL_SECONDS),
  })
  .refine((v) => (v.url === undefined) !== (v.urls === undefined), {
    message: "Pass either url or urls",
  })
export type CreateMediaLinksInput = z.input<typeof CreateMediaLinksInputSchema>

export type MediaLinksResult = {
  results: Array<
    | {
        index: number
        ok: true
        data: {
          url: string
          /** Signed URL to hand out (equals `url` when no signature is needed). */
          link: string
          /** `null` when the link does not expire (public media, CDN / bucket links). */
          expiresAt: string | null
        }
      }
    | {
        index: number
        ok: false
        url: string
        error: { code: string; message: string }
      }
  >
  summary: { total: number; succeeded: number; failed: number }
}

export type MediaEntry = StoredObject & {
  url: string
  contentType: string
  kind: MediaKind
  /** Non-deleted items whose payload, metadata or result reference it. */
  usedBy: number
}

export type MediaSummary = {
  count: number
  bytes: number
  unused: number
  byKind: Record<MediaKind, { count: number; bytes: number }>
}

export type MediaListResult = PageResult<MediaEntry> & {
  summary: MediaSummary
  /** More than `MAX_LISTED_OBJECTS` objects: only the first ones are shown. */
  truncated: boolean
  location: string
}

export type MediaUsage = {
  key: string
  url: string
  items: Array<{
    id: string
    tubeId: string
    tubeName: string
    status: ItemStatus
    fields: Array<"payload" | "metadata" | "result">
  }>
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Media keys this module writes: `<prefix>ab/<sha256>.<ext>`. */
function mediaKeyPattern(store: MediaStore): RegExp {
  return new RegExp(
    `${escapeRegExp(store.limits.prefix)}[0-9a-f]{2}/[0-9a-f]{64}\\.[a-z0-9]{1,10}`,
    "g"
  )
}

const ITEM_MEDIA_FIELDS = ["payload", "metadata", "result"] as const

/**
 * Media module: files stored in S3 and referenced from items by URL.
 *
 * - Direct upload (`POST /api/media`) returns a `MediaObject` whose `url`
 *   callers put into item payloads.
 * - Item writes (push, bulk push, update, bulk update) turn every media data
 *   URI in `payload` / `metadata` (`data:image/png;base64,...`) into such a
 *   URL before the item is stored (`materializer`).
 */
export function createMediaService(ctx: ServiceContext, actor: Actor) {
  const ac = createAccessControl(ctx, actor)

  return {
    status(): MediaStatus {
      const store = ctx.media
      if (!store) return { enabled: false }
      const { maxBytes, allowedTypes } = store.limits
      return {
        enabled: true,
        maxBytes,
        allowedTypes,
        access: mediaAccessFromEnv(),
      }
    },

    /** Uploads one file (needs `items:push`). 409 when media is disabled. */
    async upload(input: UploadMediaInput): Promise<MediaObject> {
      const parsed = UploadMediaInputSchema.parse(input)
      ac.require("items:push")
      if (!ctx.media) {
        throw new ConflictError(
          "Media storage is not configured (set MCPOCKET_S3_BUCKET)"
        )
      }
      return storeMediaFile(ctx.media, parsed)
    },

    /**
     * Downloads files from http(s) URLs (e.g. a generator's short-lived
     * link) into media storage and returns their permanent URLs. URLs that
     * already point into media storage are returned as they are. Each URL
     * gets its own result; one failure does not stop the others. Needs
     * `items:push`.
     */
    async ingest(input: unknown): Promise<IngestResult> {
      const { url, urls } = IngestMediaInputSchema.parse(input)
      ac.require("items:push")
      const store = requireStore()
      const entries = (urls ?? [url!]).map((e) =>
        typeof e === "string" ? { url: e } : e
      )
      const results: IngestResult["results"] = []
      for (const [index, entry] of entries.entries()) {
        try {
          results.push({ index, ok: true, data: await ingestOne(store, entry) })
        } catch (error) {
          if (!(error instanceof AppError)) throw error
          results.push({
            index,
            ok: false,
            sourceUrl: entry.url,
            error: {
              code: error.code,
              message: error.message,
              ...(error.details !== undefined && { details: error.details }),
            },
          })
        }
      }
      const succeeded = results.filter((r) => r.ok).length
      return {
        results,
        summary: {
          total: results.length,
          succeeded,
          failed: results.length - succeeded,
        },
      }
    },

    /**
     * Temporary signed links for stored media URLs, to hand a file to a
     * consumer without an API key (generator, social network, player).
     * With public media, or links not served by this server (CDN / bucket
     * delivery), the URL comes back unchanged with `expiresAt: null`.
     * Needs `read`.
     */
    createLinks(input: unknown): MediaLinksResult {
      const { url, urls, expiresInSeconds } =
        CreateMediaLinksInputSchema.parse(input)
      ac.require("read")
      const store = requireStore()
      const exp =
        Math.floor(ctx.clock.now().getTime() / 1000) + expiresInSeconds
      const isPrivate = mediaAccessFromEnv() === "private"
      const results: MediaLinksResult["results"] = (urls ?? [url!]).map(
        (u, index) => {
          const key = ownMediaKey(store, u)
          if (!key) {
            return {
              index,
              ok: false as const,
              url: u,
              error: {
                code: "validation_error",
                message: "Not a media URL of this server",
              },
            }
          }
          const served = new URL(u).pathname.includes(MEDIA_FILES_PATH)
          if (!isPrivate || !served) {
            return {
              index,
              ok: true as const,
              data: { url: u, link: u, expiresAt: null },
            }
          }
          const permanent = u.split(/[?#]/)[0]
          return {
            index,
            ok: true as const,
            data: {
              url: permanent,
              link: signMediaUrl(permanent, key, exp),
              expiresAt: new Date(exp * 1000).toISOString(),
            },
          }
        }
      )
      const succeeded = results.filter((r) => r.ok).length
      return {
        results,
        summary: {
          total: results.length,
          succeeded,
          failed: results.length - succeeded,
        },
      }
    },

    /**
     * A short-lived signed URL the caller can PUT one file to (no API key
     * needed by the uploader). Needs `items:push` and an API key identity.
     */
    createUploadLink(input: unknown = {}): UploadLink {
      const { contentType, filename, expiresInSeconds } =
        CreateUploadInputSchema.parse(input)
      ac.require("items:push")
      const store = requireStore()
      const keyId =
        actor.viaKeyId ?? (actor.kind === "api_key" ? actor.id : undefined)
      if (!keyId) {
        throw new ValidationError(
          "Upload links can only be created with an API key"
        )
      }
      if (!ctx.publicUrl) {
        throw new ConflictError(
          "The server's public URL is unknown (set MCPOCKET_PUBLIC_URL)"
        )
      }
      if (
        contentType &&
        !isAllowedType(contentType, store.limits.allowedTypes)
      ) {
        throw new ValidationError(
          `Media type "${contentType}" is not allowed`,
          {
            contentType,
            allowedTypes: store.limits.allowedTypes,
          }
        )
      }
      const exp =
        Math.floor(ctx.clock.now().getTime() / 1000) + expiresInSeconds
      const token = createUploadToken(
        {
          k: keyId,
          e: exp,
          ...(contentType && { t: contentType.toLowerCase() }),
          ...(filename && { n: filename }),
          ...(ctx.workspace && { w: ctx.workspace }),
        },
        uploadSigningKey()
      )
      const uploadUrl = `${ctx.publicUrl}/api/media/uploads/${token}`
      const type = contentType ?? "<content-type>"
      return {
        uploadUrl,
        method: "PUT",
        headers: { "Content-Type": type },
        expiresAt: new Date(exp * 1000).toISOString(),
        maxBytes: store.limits.maxBytes,
        allowedTypes: store.limits.allowedTypes,
        curl: `curl -fsS -X PUT -H 'Content-Type: ${type}' --data-binary @FILE '${uploadUrl}'`,
      }
    },

    /**
     * The media library: every object under the prefix (newest first),
     * filtered by kind / usage and paginated, with totals and how many
     * items reference each object. With `tubeId`: only files that tube's
     * items reference, totals and counts for that tube. Needs `read`.
     */
    async list(input: unknown = {}): Promise<MediaListResult> {
      const { tubeId, kind, usage, offset, limit } =
        ListMediaInputSchema.parse(input)
      ac.require("read")
      const store = requireStore()
      if (tubeId !== undefined) {
        const tube = await ctx.storage.tubes.get(tubeId)
        if (!tube) throw new NotFoundError("Tube", tubeId)
        ac.assertTube(await ac.view(), tube)
      }
      const [{ objects, truncated }, counts] = await Promise.all([
        store.list(),
        usageCounts(store, tubeId),
      ])
      const byKind = Object.fromEntries(
        MEDIA_KINDS.map((k) => [k, { count: 0, bytes: 0 }])
      ) as MediaSummary["byKind"]
      const summary: MediaSummary = { count: 0, bytes: 0, unused: 0, byKind }
      const entries: MediaEntry[] = objects
        .map((o) => {
          const contentType = contentTypeFromKey(o.key)
          return {
            ...o,
            url: store.urlFor(o.key),
            contentType,
            kind: mediaKind(contentType),
            usedBy: counts.get(o.key) ?? 0,
          }
        })
        // In a tube: only the files its items reference.
        .filter((e) => tubeId === undefined || e.usedBy > 0)
        .sort(
          (a, b) =>
            b.lastModified.localeCompare(a.lastModified) ||
            a.key.localeCompare(b.key)
        )
      for (const e of entries) {
        summary.count++
        summary.bytes += e.size
        byKind[e.kind].count++
        byKind[e.kind].bytes += e.size
        if (e.usedBy === 0) summary.unused++
      }
      const matches = entries.filter(
        (e) =>
          (!kind || e.kind === kind) &&
          (!usage || (usage === "used") === e.usedBy > 0)
      )
      return {
        data: matches.slice(offset, offset + limit),
        page: { offset, limit, total: matches.length },
        summary,
        truncated,
        location: store.location,
      }
    },

    /** Items (in the caller's scope) that reference a media object. */
    async usage(key: string): Promise<MediaUsage> {
      ac.require("read")
      const store = requireStore()
      assertMediaKey(store, key)
      const scope = await ac.view()
      const tubes = new Map(
        (await ctx.storage.tubes.list()).map((t) => [t.id, t])
      )
      const items: MediaUsage["items"] = []
      for (const item of await ctx.storage.items.list({})) {
        const tube = tubes.get(item.tubeId)
        if (!tube || !scope.canAccessTube(tube)) continue
        const fields = ITEM_MEDIA_FIELDS.filter((f) =>
          JSON.stringify(item[f] ?? null).includes(key)
        )
        if (fields.length === 0) continue
        items.push({
          id: item.id,
          tubeId: tube.id,
          tubeName: tube.name,
          status: item.status,
          fields,
        })
      }
      return { key, url: store.urlFor(key), items }
    },

    /**
     * Deletes one object from the bucket (needs `items:manage`). Items that
     * still reference its URL keep a broken link — check `usage` first.
     */
    async delete(key: string): Promise<{ key: string }> {
      ac.require("items:manage")
      const store = requireStore()
      assertMediaKey(store, key)
      const { objects } = await store.list()
      if (!objects.some((o) => o.key === key)) {
        throw new NotFoundError("Media", key)
      }
      await store.delete(key)
      return { key }
    },
  }

  async function ingestOne(
    store: MediaStore,
    entry: { url: string; contentType?: string; filename?: string }
  ): Promise<IngestedMedia> {
    const own = ownMediaKey(store, entry.url)
    if (own) {
      const contentType = contentTypeFromKey(own)
      return {
        url: entry.url,
        key: own,
        contentType,
        sha256: own.slice(own.lastIndexOf("/") + 1, own.lastIndexOf(".")),
        sourceUrl: entry.url,
        reused: true,
      }
    }
    const fetched = await ctx.mediaFetcher(entry.url, {
      maxBytes: store.limits.maxBytes,
    })
    if (fetched.body.byteLength === 0) {
      throw new ValidationError(`Empty file at ${entry.url}`, {
        url: entry.url,
      })
    }
    const filename = entry.filename ?? fetched.filename
    const stored = await storeMediaFile(store, {
      body: fetched.body,
      contentType: entry.contentType ?? fetched.contentType,
      ...(filename && { filename }),
    })
    return { ...stored, sourceUrl: entry.url }
  }

  function requireStore(): MediaStore {
    if (!ctx.media) {
      throw new ConflictError(
        "Media storage is not configured (set MCPOCKET_S3_BUCKET)"
      )
    }
    return ctx.media
  }

  /** Only objects under the media prefix can be read or deleted. */
  function assertMediaKey(store: MediaStore, key: string) {
    if (
      typeof key !== "string" ||
      key.length > 1024 ||
      !key.startsWith(store.limits.prefix) ||
      key.split("/").some((part) => part === ".." || part === "")
    ) {
      throw new ValidationError(
        `Media key must be under "${store.limits.prefix}"`,
        { key }
      )
    }
  }

  /**
   * key → number of in-scope, non-deleted items referencing it (one scan),
   * optionally only items of one tube.
   */
  async function usageCounts(
    store: MediaStore,
    tubeId?: string
  ): Promise<Map<string, number>> {
    const scope = await ac.view()
    const tubes = new Map(
      (await ctx.storage.tubes.list()).map((t) => [t.id, t])
    )
    const pattern = mediaKeyPattern(store)
    const counts = new Map<string, number>()
    for (const item of await ctx.storage.items.list(
      tubeId !== undefined ? { tubeId } : {}
    )) {
      const tube = tubes.get(item.tubeId)
      if (!tube || !scope.canAccessTube(tube)) continue
      const text = JSON.stringify(
        ITEM_MEDIA_FIELDS.map((f) => (item as Item)[f] ?? null)
      )
      for (const key of new Set(text.match(pattern) ?? [])) {
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    return counts
  }
}

/** Per-request data URI → URL transformer (pass-through when media is off). */
export function mediaMaterializer(ctx: ServiceContext): MediaMaterializer {
  return createMediaMaterializer(ctx.media)
}

/** `<prefix>ab/<sha256>.<ext>` when `url` is one of this store's objects. */
function ownMediaKey(store: MediaStore, url: string): string | null {
  const probe = store.urlFor(`${store.limits.prefix}x`)
  const base = probe.slice(0, -1)
  if (!url.startsWith(base)) return null
  let rest: string
  try {
    rest = decodeURIComponent(url.slice(base.length).split(/[?#]/)[0])
  } catch {
    return null
  }
  return OWN_KEY_RE.test(rest) ? `${store.limits.prefix}${rest}` : null
}

export type AuthorizedUpload = {
  claims: UploadClaims
  keyId: string
  /** The key's own limit (managed keys); `null` = server default. */
  rateLimitPerMinute: number | null
}

/**
 * Workspace an upload link was created in (multi-workspace mode), so the
 * upload route can build that workspace's context before `authorizeUpload`.
 * Throws `UnauthorizedError` for an invalid or expired link.
 */
export function uploadTokenWorkspace(
  token: string,
  now: Date = new Date()
): string | undefined {
  const claims = verifyUploadToken(
    token,
    uploadSigningKey(),
    Math.floor(now.getTime() / 1000)
  )
  return typeof claims.w === "string" ? claims.w : undefined
}

/**
 * `PUT /api/media/uploads/{token}`, step 1: the token is valid and
 * unexpired, and its API key still exists, is not revoked and may push.
 */
export async function authorizeUpload(
  ctx: ServiceContext,
  token: string
): Promise<AuthorizedUpload> {
  const claims = verifyUploadToken(
    token,
    uploadSigningKey(),
    Math.floor(ctx.clock.now().getTime() / 1000)
  )
  const envKey = apiKeysFromEnv().find((k) => k.id === claims.k)
  let role: Role
  let rateLimitPerMinute: number | null = null
  if (envKey) {
    role = envKey.role
  } else {
    const managed = await ctx.storage.apiKeys.get(claims.k)
    if (!managed || managed.revokedAt) {
      throw new UnauthorizedError("Invalid or expired upload link")
    }
    role = managed.role
    rateLimitPerMinute = managed.rateLimitPerMinute ?? null
  }
  if (!roleHasCapability(role, "items:push")) {
    throw new ForbiddenError("This upload link's API key cannot push media")
  }
  return { claims, keyId: claims.k, rateLimitPerMinute }
}

/** Step 2: stores the file (content type must match the link's lock). */
export async function uploadWithToken(
  ctx: ServiceContext,
  { claims }: AuthorizedUpload,
  file: UploadMediaInput
): Promise<MediaObject> {
  if (!ctx.media) {
    throw new ConflictError(
      "Media storage is not configured (set MCPOCKET_S3_BUCKET)"
    )
  }
  const parsed = UploadMediaInputSchema.parse(file)
  const type = parsed.contentType.split(";")[0].trim().toLowerCase()
  if (claims.t && type !== claims.t) {
    throw new ValidationError(
      `This upload link expects Content-Type ${claims.t} (got ${type})`,
      { expected: claims.t, contentType: type }
    )
  }
  return storeMediaFile(ctx.media, {
    ...parsed,
    ...(claims.n && !parsed.filename && { filename: claims.n }),
  })
}

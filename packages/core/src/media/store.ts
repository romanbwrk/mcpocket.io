import type { S3Client } from "@aws-sdk/client-s3"

import { mediaConfigFromEnv, type MediaConfig } from "./config"

export type PutMediaInput = {
  key: string
  body: Uint8Array
  contentType: string
  filename?: string
}

/** Path of the media endpoint (`server` delivery): `<origin><path><key>`. */
export const MEDIA_FILES_PATH = "/api/media/files/"

/** Bytes of an object (or of a byte range of it) for the media endpoint. */
export type MediaObjectBody = {
  body: ReadableStream<Uint8Array>
  /** Bytes in `body`. */
  length: number
  /** Size of the whole object. */
  totalSize: number
  /** `bytes start-end/total` for a range read. */
  contentRange?: string
  contentType?: string
  contentDisposition?: string
}

/** A `Range` request outside the object (→ 416). */
export class RangeNotSatisfiableError extends Error {
  constructor(readonly totalSize: number) {
    super("Range not satisfiable")
  }
}

/** An object found by `MediaStore.list` (S3 listings carry no content type). */
export type StoredObject = {
  key: string
  size: number
  lastModified: string
}

/** Max objects a full listing scans (dashboard gallery). */
export const MAX_LISTED_OBJECTS = 10_000

/**
 * Where media bytes go. `S3MediaStore` in production; tests inject
 * `createMemoryMediaStore()` through `createServiceContext({ media })`.
 */
export type MediaStore = {
  /** Limits applied before anything is uploaded. */
  readonly limits: Pick<MediaConfig, "prefix" | "maxBytes" | "allowedTypes">
  put(input: PutMediaInput): Promise<void>
  /**
   * Every object under the media prefix, up to `MAX_LISTED_OBJECTS`
   * (`truncated` when there are more).
   */
  list(): Promise<{ objects: StoredObject[]; truncated: boolean }>
  delete(key: string): Promise<void>
  /**
   * An object's bytes, optionally one `Range` (`bytes=0-99`, `bytes=100-`,
   * `bytes=-100`); `null` when it does not exist. Throws
   * `RangeNotSatisfiableError` for a range outside the object.
   */
  get(key: string, range?: string): Promise<MediaObjectBody | null>
  /** Size and type without the bytes (HEAD); `null` when missing. */
  stat(key: string): Promise<{ size: number; contentType?: string } | null>
  /**
   * Public URL of an object key. `origin` is the requesting server's
   * public origin, used by `server` delivery when `MCPOCKET_PUBLIC_URL` is
   * not set.
   */
  urlFor(key: string, origin?: string): string
  /** Where objects live, for display (`s3://bucket/prefix`). */
  readonly location: string
  /** The same store (shared client) writing and listing under another prefix. */
  withPrefix(prefix: string): MediaStore
}

/**
 * The store of a workspace in multi-workspace mode: objects under
 * `<prefix><workspace>/` (the base prefix is shared by all workspaces).
 */
export function mediaStoreForWorkspace(
  store: MediaStore,
  workspace: string
): MediaStore {
  return store.withPrefix(`${store.limits.prefix}${workspace}/`)
}

const encodeKey = (key: string) =>
  key.split("/").map(encodeURIComponent).join("/")

/** RFC 6266 `inline; filename*=UTF-8''...` (ASCII fallback included). */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_")
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

export function publicUrlFor(
  config: MediaConfig,
  key: string,
  origin?: string
): string {
  const path = encodeKey(key)
  if (config.publicUrl) return `${config.publicUrl}/${path}`
  if (config.delivery === "server") {
    const base = (config.serverUrl ?? origin ?? "").replace(/\/+$/, "")
    return `${base}${MEDIA_FILES_PATH}${path}`
  }
  if (config.endpoint) {
    if (config.forcePathStyle)
      return `${config.endpoint}/${config.bucket}/${path}`
    const url = new URL(config.endpoint)
    return `${url.protocol}//${config.bucket}.${url.host}/${path}`
  }
  return `https://${config.bucket}.s3.${config.region}.amazonaws.com/${path}`
}

type S3Handle = Promise<{
  client: S3Client
  sdk: typeof import("@aws-sdk/client-s3")
}>

export function createS3MediaStore(
  config: MediaConfig,
  sharedClient?: () => S3Handle
): MediaStore {
  let client: S3Handle | undefined
  // The SDK is loaded on first use, so instances without media never pay for it.
  const getClient =
    sharedClient ??
    (() =>
      (client ??= import("@aws-sdk/client-s3").then((sdk) => ({
        sdk,
        client: new sdk.S3Client({
          region: config.region,
          ...(config.endpoint && { endpoint: config.endpoint }),
          forcePathStyle: config.forcePathStyle,
          ...(config.accessKeyId && {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey!,
            },
          }),
        }),
      }))))

  return {
    limits: config,
    async put({ key, body, contentType, filename }) {
      const { sdk, client } = await getClient()
      try {
        await client.send(
          new sdk.PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            ContentLength: body.byteLength,
            // Keys are content hashes: an object never changes once written.
            CacheControl: "public, max-age=31536000, immutable",
            ...(filename && {
              ContentDisposition: contentDisposition(filename),
            }),
            ...(config.acl && { ACL: config.acl as never }),
          })
        )
      } catch (error) {
        throw new Error(
          `Media upload to s3://${config.bucket}/${key} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        )
      }
    },
    async list() {
      const { sdk, client } = await getClient()
      const objects: StoredObject[] = []
      let token: string | undefined
      try {
        do {
          const page = await client.send(
            new sdk.ListObjectsV2Command({
              Bucket: config.bucket,
              Prefix: config.prefix,
              ContinuationToken: token,
              MaxKeys: 1000,
            })
          )
          for (const o of page.Contents ?? []) {
            if (!o.Key || o.Key.endsWith("/")) continue
            objects.push({
              key: o.Key,
              size: o.Size ?? 0,
              lastModified: (o.LastModified ?? new Date(0)).toISOString(),
            })
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined
        } while (token && objects.length < MAX_LISTED_OBJECTS)
      } catch (error) {
        throw new Error(
          `Listing s3://${config.bucket}/${config.prefix} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        )
      }
      return {
        objects: objects.slice(0, MAX_LISTED_OBJECTS),
        truncated: token !== undefined || objects.length > MAX_LISTED_OBJECTS,
      }
    },
    async delete(key) {
      const { sdk, client } = await getClient()
      try {
        await client.send(
          new sdk.DeleteObjectCommand({ Bucket: config.bucket, Key: key })
        )
      } catch (error) {
        throw new Error(
          `Deleting s3://${config.bucket}/${key} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        )
      }
    },
    async get(key, range) {
      const { sdk, client } = await getClient()
      try {
        const res = await client.send(
          new sdk.GetObjectCommand({
            Bucket: config.bucket,
            Key: key,
            ...(range && { Range: range }),
          })
        )
        if (!res.Body) return null
        const length = res.ContentLength ?? 0
        const total = res.ContentRange
          ? Number(res.ContentRange.split("/")[1])
          : length
        return {
          body: res.Body.transformToWebStream() as ReadableStream<Uint8Array>,
          length,
          totalSize: Number.isFinite(total) ? total : length,
          ...(res.ContentRange && { contentRange: res.ContentRange }),
          ...(res.ContentType && { contentType: res.ContentType }),
          ...(res.ContentDisposition && {
            contentDisposition: res.ContentDisposition,
          }),
        }
      } catch (error) {
        const name = (error as { name?: string }).name
        if (name === "NoSuchKey" || name === "NotFound") return null
        if (name === "InvalidRange") {
          const stat = await this.stat(key)
          throw new RangeNotSatisfiableError(stat?.size ?? 0)
        }
        throw new Error(
          `Reading s3://${config.bucket}/${key} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        )
      }
    },
    async stat(key) {
      const { sdk, client } = await getClient()
      try {
        const res = await client.send(
          new sdk.HeadObjectCommand({ Bucket: config.bucket, Key: key })
        )
        return {
          size: res.ContentLength ?? 0,
          ...(res.ContentType && { contentType: res.ContentType }),
        }
      } catch (error) {
        const name = (error as { name?: string }).name
        if (name === "NoSuchKey" || name === "NotFound") return null
        throw new Error(
          `Reading s3://${config.bucket}/${key} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        )
      }
    },
    urlFor: (key, origin) => publicUrlFor(config, key, origin),
    location: `s3://${config.bucket}/${config.prefix}`,
    withPrefix: (prefix) =>
      createS3MediaStore({ ...config, prefix }, getClient),
  }
}

/**
 * One `bytes=` range against an object of `total` bytes (inclusive
 * `start`/`end`), or `null` when it cannot be satisfied.
 */
export function parseByteRange(
  header: string,
  total: number
): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === "" && m[2] === "") || total === 0) return null
  if (m[1] === "") {
    const suffix = Number(m[2])
    if (suffix === 0) return null
    return { start: Math.max(0, total - suffix), end: total - 1 }
  }
  const start = Number(m[1])
  const end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1)
  if (start >= total || end < start) return null
  return { start, end }
}

/** In-memory store for tests and local experiments. */
export function createMemoryMediaStore(
  limits: Partial<MediaStore["limits"]> = {},
  baseUrl = "https://media.test",
  shared?: { objects: Map<string, PutMediaInput & { at: string }> }
): MediaStore & { objects: Map<string, PutMediaInput & { at: string }> } {
  const objects =
    shared?.objects ?? new Map<string, PutMediaInput & { at: string }>()
  let seq = objects.size
  const prefix = limits.prefix ?? "media/"
  return {
    objects,
    limits: {
      prefix,
      maxBytes: limits.maxBytes ?? 50 * 1024 * 1024,
      allowedTypes: limits.allowedTypes ?? [],
    },
    async put(input) {
      // Strictly increasing timestamps keep "newest first" deterministic.
      objects.set(input.key, {
        ...input,
        at: new Date(Date.UTC(2026, 0, 1) + seq++ * 1000).toISOString(),
      })
    },
    async list() {
      return {
        objects: [...objects.values()]
          .filter((o) => o.key.startsWith(prefix))
          .map((o) => ({
            key: o.key,
            size: o.body.byteLength,
            lastModified: o.at,
          })),
        truncated: false,
      }
    },
    async delete(key) {
      objects.delete(key)
    },
    async get(key, range) {
      const o = objects.get(key)
      if (!o) return null
      const total = o.body.byteLength
      let start = 0
      let end = total - 1
      if (range) {
        const r = parseByteRange(range, total)
        if (!r) throw new RangeNotSatisfiableError(total)
        ;({ start, end } = r)
      }
      const bytes = o.body.slice(start, end + 1)
      return {
        body: new Blob([bytes]).stream(),
        length: bytes.byteLength,
        totalSize: total,
        ...(range && { contentRange: `bytes ${start}-${end}/${total}` }),
        contentType: o.contentType,
      }
    },
    async stat(key) {
      const o = objects.get(key)
      return o ? { size: o.body.byteLength, contentType: o.contentType } : null
    },
    urlFor: (key) => `${baseUrl}/${encodeKey(key)}`,
    location: "memory://media",
    withPrefix: (next) =>
      createMemoryMediaStore({ ...limits, prefix: next }, baseUrl, { objects }),
  }
}

const GLOBAL_KEY = Symbol.for("mcpocket.mediaStore")
type GlobalSlot = { [GLOBAL_KEY]?: { store: MediaStore | null } }

/**
 * Process-wide store from the environment (`null` = media disabled). Kept on
 * `globalThis` so dev hot reloads reuse the same S3 client.
 */
export function getMediaStore(): MediaStore | null {
  const slot = globalThis as GlobalSlot
  if (!slot[GLOBAL_KEY]) {
    const config = mediaConfigFromEnv()
    slot[GLOBAL_KEY] = { store: config ? createS3MediaStore(config) : null }
  }
  return slot[GLOBAL_KEY].store
}

/**
 * Tests: replace the process-wide store (`undefined` = re-read the
 * environment on next use).
 */
export function resetMediaStore(store?: MediaStore | null) {
  const slot = globalThis as GlobalSlot
  if (store === undefined) delete slot[GLOBAL_KEY]
  else slot[GLOBAL_KEY] = { store }
}

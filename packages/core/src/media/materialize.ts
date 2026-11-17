import { createHash } from "node:crypto"

import { PayloadTooLargeError, ValidationError } from "../domain/errors"

import { isAllowedType } from "./config"
import {
  decodeDataUri,
  estimateDataUriBytes,
  extensionFor,
  parseDataUriHeader,
  type DataUriHeader,
} from "./data-uri"
import type { MediaStore } from "./store"

/** A stored media object (`POST /api/media` response, `data` field). */
export type MediaObject = {
  url: string
  key: string
  contentType: string
  size: number
  sha256: string
  filename?: string
}

export type MediaFile = {
  body: Uint8Array
  contentType: string
  filename?: string
}

/** Concurrent uploads per request. */
const UPLOAD_CONCURRENCY = 4

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i

function assertAllowed(
  store: MediaStore,
  contentType: string,
  size: number,
  path?: string
) {
  const { maxBytes, allowedTypes } = store.limits
  const where = path ? ` at ${path}` : ""
  if (!MIME.test(contentType)) {
    throw new ValidationError(`Invalid media type "${contentType}"${where}`, {
      ...(path && { path }),
      contentType,
    })
  }
  if (!isAllowedType(contentType, allowedTypes)) {
    throw new ValidationError(
      `Media type "${contentType}"${where} is not allowed`,
      { ...(path && { path }), contentType, allowedTypes }
    )
  }
  if (size > maxBytes) {
    throw new PayloadTooLargeError(`Media${where} exceeds ${maxBytes} bytes`, {
      ...(path && { path }),
      maxBytes,
      size,
    })
  }
}

/**
 * Validates and uploads one file under a content-addressed key
 * (`<prefix><sha[0..2]>/<sha256>.<ext>`): the same bytes always map to the
 * same object, so retries and idempotent replays never create duplicates.
 */
export async function storeMediaFile(
  store: MediaStore,
  file: MediaFile,
  path?: string
): Promise<MediaObject> {
  const contentType = file.contentType.split(";")[0].trim().toLowerCase()
  assertAllowed(store, contentType, file.body.byteLength, path)
  const sha256 = createHash("sha256").update(file.body).digest("hex")
  const key = `${store.limits.prefix}${sha256.slice(0, 2)}/${sha256}.${extensionFor(contentType, file.filename)}`
  await store.put({
    key,
    body: file.body,
    contentType,
    ...(file.filename && { filename: file.filename }),
  })
  return {
    url: store.urlFor(key),
    key,
    contentType,
    size: file.body.byteLength,
    sha256,
    ...(file.filename && { filename: file.filename }),
  }
}

type Found = { uri: string; header: DataUriHeader; path: string }

function collect(value: unknown, path: string, out: Found[]) {
  if (typeof value === "string") {
    const header = parseDataUriHeader(value)
    if (header) out.push({ uri: value, header, path })
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collect(v, `${path}[${i}]`, out))
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      collect(
        v,
        /^[A-Za-z_$][\w$]*$/.test(k)
          ? `${path}.${k}`
          : `${path}[${JSON.stringify(k)}]`,
        out
      )
    }
  }
}

function replace(value: unknown, urls: Map<string, string>): unknown {
  if (typeof value === "string") return urls.get(value) ?? value
  if (Array.isArray(value)) return value.map((v) => replace(v, urls))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, replace(v, urls)])
    )
  }
  return value
}

async function pool<T>(tasks: Array<() => Promise<T>>, limit: number) {
  const results: T[] = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker)
  )
  return results
}

export type MediaMaterializer = <T>(value: T, path: string) => Promise<T>

/**
 * Returns a function that uploads every media data URI inside a JSON value
 * and returns a copy with each one replaced by its public URL. All URIs are
 * validated (type, size, encoding) before the first upload; a value without
 * data URIs is returned as is. Uploads are de-duplicated for the lifetime of
 * the materializer (one request). With no store (media disabled) values pass
 * through unchanged.
 */
export function createMediaMaterializer(
  store: MediaStore | null
): MediaMaterializer {
  // data URI → URL of everything uploaded so far (call sequentially).
  const uploads = new Map<string, string>()

  return async function materialize<T>(value: T, path: string): Promise<T> {
    if (!store) return value
    const found: Found[] = []
    collect(value, path, found)
    if (found.length === 0) return value

    const pending = new Map<string, () => Promise<string>>()
    for (const { uri, header, path: at } of found) {
      if (uploads.has(uri) || pending.has(uri)) continue
      assertAllowed(
        store,
        header.contentType,
        estimateDataUriBytes(uri, header),
        at
      )
      const body = decodeDataUri(uri, header)
      if (!body) {
        throw new ValidationError(`Invalid data URI encoding at ${at}`, {
          path: at,
        })
      }
      assertAllowed(store, header.contentType, body.byteLength, at)
      pending.set(uri, () =>
        storeMediaFile(
          store,
          {
            body,
            contentType: header.contentType,
            ...(header.filename && { filename: header.filename }),
          },
          at
        ).then((m) => m.url)
      )
    }

    const entries = [...pending]
    const urls = await pool(
      entries.map(([, task]) => task),
      UPLOAD_CONCURRENCY
    )
    entries.forEach(([uri], i) => uploads.set(uri, urls[i]))
    return replace(value, uploads) as T
  }
}

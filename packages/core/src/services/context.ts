import { randomUUID } from "node:crypto"

import {
  retryDefaultsFromEnv,
  type ResolvedRetryPolicy,
} from "../domain/retry-policy"
import { MAX_LEASE_SECONDS } from "../domain/schemas"
import { getEventBus, type EventPublisher } from "../events/bus"
import { createHttpMediaFetcher, type MediaFetcher } from "../media/ingest"
import { getMediaStore, type MediaStore } from "../media/store"
import type { Storage } from "../storage"

/** Injectable time source, so lease/retry logic can be tested with a fake clock. */
export type Clock = { now: () => Date }

export const systemClock: Clock = { now: () => new Date() }

/**
 * Everything an application service needs. Services receive this instead of
 * reaching for globals, so tests can pass an isolated storage and clock.
 */
export type ServiceContext = {
  storage: Storage
  /** Workspace the services act in (multi-workspace mode); unset = the instance's. */
  workspace?: string
  clock: Clock
  newId: () => string
  /** Default lease duration (seconds) for claim / heartbeat. */
  leaseSeconds: number
  /** Global retry policy defaults (tubes may override per field). */
  retryDefaults: ResolvedRetryPolicy
  /** Where committed writes publish domain events (process-wide bus by default). */
  events: EventPublisher
  /**
   * S3 media store (`MCPOCKET_S3_*`); `null` = media disabled, data URIs in
   * items are stored unchanged.
   */
  media: MediaStore | null
  /** Downloads media from URLs for `ingest_media` (SSRF-guarded by default). */
  mediaFetcher: MediaFetcher
  /**
   * Public origin of this server (`MCPOCKET_PUBLIC_URL`, else the request's
   * origin), used to build absolute links such as media upload URLs.
   */
  publicUrl?: string
}

/** Built on first use, so a bad ingest env var only fails ingest calls. */
let httpFetcher: MediaFetcher | undefined
const lazyHttpFetcher: MediaFetcher = (url, options) =>
  (httpFetcher ??= createHttpMediaFetcher())(url, options)

/**
 * The server's public origin for a request: `MCPOCKET_PUBLIC_URL`, else
 * `X-Forwarded-Proto` / `X-Forwarded-Host` (reverse proxies), else the
 * request URL's origin.
 */
export function publicUrlFor(
  request: Request,
  env: Record<string, string | undefined> = process.env
): string {
  return publicOrigin(request.headers, new URL(request.url), env)
}

/**
 * `publicUrlFor` from headers alone (server components / actions); without
 * a request URL the host comes from `Host` and the scheme defaults to http.
 */
export function publicOrigin(
  headers: Headers,
  requestUrl?: URL,
  env: Record<string, string | undefined> = process.env
): string {
  const configured = env.MCPOCKET_PUBLIC_URL?.trim().replace(/\/+$/, "")
  if (configured) return configured
  const first = (name: string) =>
    headers.get(name)?.split(",")[0].trim() || undefined
  const host = first("x-forwarded-host") ?? requestUrl?.host ?? first("host")
  const proto =
    first("x-forwarded-proto") ??
    requestUrl?.protocol.replace(/:$/, "") ??
    "http"
  return `${proto}://${host ?? "localhost"}`
}

export const DEFAULT_LEASE_SECONDS = 300
export { MAX_LEASE_SECONDS }

/** `MCPOCKET_LEASE_SECONDS` (1..86400), default 300. */
export function leaseSecondsFromEnv(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.MCPOCKET_LEASE_SECONDS?.trim()
  if (!raw) return DEFAULT_LEASE_SECONDS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_LEASE_SECONDS) {
    throw new Error(
      `Invalid MCPOCKET_LEASE_SECONDS "${raw}" (integer 1..${MAX_LEASE_SECONDS})`
    )
  }
  return n
}

export function createServiceContext(
  storage: Storage,
  overrides: Partial<Omit<ServiceContext, "storage">> = {}
): ServiceContext {
  const media =
    overrides.media !== undefined ? overrides.media : getMediaStore()
  return {
    storage,
    clock: systemClock,
    newId: randomUUID,
    leaseSeconds: overrides.leaseSeconds ?? leaseSecondsFromEnv(),
    retryDefaults: overrides.retryDefaults ?? retryDefaultsFromEnv(),
    events: overrides.events ?? getEventBus(),
    mediaFetcher: overrides.mediaFetcher ?? lazyHttpFetcher,
    ...overrides,
    media: withOrigin(media, overrides.publicUrl),
  }
}

/**
 * The store with `urlFor` bound to this request's public origin, so media
 * links served by this server (`server` delivery) are absolute.
 */
function withOrigin(
  store: MediaStore | null,
  origin: string | undefined
): MediaStore | null {
  if (!store || !origin) return store
  return { ...store, urlFor: (key) => store.urlFor(key, origin) }
}

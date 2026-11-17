import { lookup as dnsLookup, type LookupAddress } from "node:dns"
import http, { type IncomingMessage } from "node:http"
import https from "node:https"
import { BlockList, isIP } from "node:net"

import { PayloadTooLargeError, ValidationError } from "../domain/errors"

import { contentTypeFromKey } from "./kinds"

/**
 * Media ingest: the server downloads a file from an http(s) URL so it can be
 * stored in S3 under a permanent URL. Generators (image / video APIs) hand
 * agents short-lived URLs; an LLM agent cannot re-encode those bytes as a
 * data URI, so it passes the URL and the server fetches it.
 *
 * SSRF guard: only http(s), no credentials in the URL, and every hop
 * (redirects included) must resolve to public addresses only. The check
 * runs inside the socket's DNS lookup, so the address that is validated is
 * the address that is connected to (no DNS-rebinding window).
 */

export type FetchedMedia = {
  body: Uint8Array
  /** From the response, or guessed from the URL's extension. */
  contentType: string
  /** Last path segment of the final URL, when it looks like a file name. */
  filename?: string
  /** URL after redirects. */
  finalUrl: string
}

export type MediaFetcher = (
  url: string,
  options: { maxBytes: number }
) => Promise<FetchedMedia>

export type MediaIngestOptions = {
  /** Allow private / loopback / link-local targets (local dev only). */
  allowPrivate: boolean
  timeoutMs: number
  maxRedirects: number
}

export const DEFAULT_INGEST_TIMEOUT_SECONDS = 120
const MAX_REDIRECTS = 5

type Env = Record<string, string | undefined>

/** `MCPOCKET_MEDIA_INGEST_ALLOW_PRIVATE`, `MCPOCKET_MEDIA_INGEST_TIMEOUT_SECONDS`. */
export function mediaIngestOptionsFromEnv(
  env: Env = process.env
): MediaIngestOptions {
  const rawPrivate =
    env.MCPOCKET_MEDIA_INGEST_ALLOW_PRIVATE?.trim().toLowerCase()
  const rawTimeout = env.MCPOCKET_MEDIA_INGEST_TIMEOUT_SECONDS?.trim()
  const seconds =
    rawTimeout === undefined || rawTimeout === ""
      ? DEFAULT_INGEST_TIMEOUT_SECONDS
      : Number(rawTimeout)
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error(
      `Invalid MCPOCKET_MEDIA_INGEST_TIMEOUT_SECONDS "${rawTimeout}" (integer 1..3600)`
    )
  }
  return {
    allowPrivate: ["1", "true", "yes", "on"].includes(rawPrivate ?? ""),
    timeoutMs: seconds * 1000,
    maxRedirects: MAX_REDIRECTS,
  }
}

/** Non-public address ranges (RFC 6890 special-purpose + multicast). */
const BLOCKED = new BlockList()
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4")
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6")
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  // IPv4-mapped IPv6 (::ffff:a.b.c.d / ::ffff:7f00:1): never a public answer.
  // (Not a BlockList rule: Node matches plain IPv4 addresses against it.)
  if (family === 6 && /^(0{0,4}:){0,5}:?ffff:/i.test(address)) return false
  return !BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6")
}

const fail = (message: string, url: string) =>
  new ValidationError(message, { url })

/** Parses and checks a URL before anything is fetched. */
export function assertFetchableUrl(raw: string, allowPrivate = false): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw fail(`Invalid URL "${raw}"`, raw)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw fail(`Only http(s) URLs can be ingested (got ${url.protocol})`, raw)
  }
  if (url.username || url.password) {
    throw fail("URLs with credentials cannot be ingested", raw)
  }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (!allowPrivate && isIP(host) !== 0 && !isPublicAddress(host)) {
    throw fail(`Refusing to fetch a non-public address (${host})`, raw)
  }
  return url
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void

/** `dns.lookup` that rejects hosts resolving to any non-public address. */
function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number | "IPv4" | "IPv6" },
  callback: LookupCallback
) {
  const family = options.family === 0 ? undefined : options.family
  dnsLookup(hostname, { family, all: true }, (err, list) => {
    if (err) return callback(err, [])
    const blocked = list.find((a) => !isPublicAddress(a.address))
    if (blocked || list.length === 0) {
      const error: NodeJS.ErrnoException = new Error(
        `Refusing to fetch ${hostname}: resolves to a non-public address${
          blocked ? ` (${blocked.address})` : ""
        }`
      )
      error.code = "EBLOCKEDADDRESS"
      return callback(error, [])
    }
    if (options.all) return callback(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const GENERIC_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
])

function request(
  url: URL,
  { allowPrivate, signal }: { allowPrivate: boolean; signal: AbortSignal }
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http
    const req = mod.request(url, {
      method: "GET",
      signal,
      headers: { "user-agent": "mcpocket-media-ingest", accept: "*/*" },
      ...(!allowPrivate && { lookup: guardedLookup as never }),
    })
    req.once("response", resolve)
    req.once("error", reject)
    req.end()
  })
}

async function readCapped(
  res: IncomingMessage,
  maxBytes: number,
  url: string
): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > maxBytes) {
      res.destroy()
      throw new PayloadTooLargeError(
        `Media at ${url} exceeds ${maxBytes} bytes`,
        {
          url,
          maxBytes,
        }
      )
    }
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks, size))
}

function filenameOf(url: URL): string | undefined {
  const last = url.pathname.split("/").pop() ?? ""
  if (!/\.[a-z0-9]{1,10}$/i.test(last)) return undefined
  try {
    return decodeURIComponent(last).slice(0, 255) || undefined
  } catch {
    return last.slice(0, 255) || undefined
  }
}

/** The production fetcher (node http/https with the SSRF guard). */
export function createHttpMediaFetcher(
  options: MediaIngestOptions = mediaIngestOptionsFromEnv()
): MediaFetcher {
  const { allowPrivate, timeoutMs, maxRedirects } = options
  return async (raw, { maxBytes }) => {
    const signal = AbortSignal.timeout(timeoutMs)
    let url = assertFetchableUrl(raw, allowPrivate)
    for (let hop = 0; ; hop++) {
      let res: IncomingMessage
      try {
        res = await request(url, { allowPrivate, signal })
      } catch (error) {
        const reason = signal.aborted
          ? `timed out after ${timeoutMs / 1000}s`
          : error instanceof Error
            ? error.message
            : String(error)
        throw fail(`Could not fetch ${url.href}: ${reason}`, raw)
      }
      const status = res.statusCode ?? 0
      if (REDIRECTS.has(status) && res.headers.location) {
        res.resume()
        if (hop >= maxRedirects) {
          throw fail(`Too many redirects fetching ${raw}`, raw)
        }
        url = assertFetchableUrl(
          new URL(res.headers.location, url).href,
          allowPrivate
        )
        continue
      }
      if (status < 200 || status >= 300) {
        res.resume()
        throw fail(`Fetching ${url.href} failed: HTTP ${status}`, raw)
      }
      const declared = Number(res.headers["content-length"])
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy()
        throw new PayloadTooLargeError(
          `Media at ${url.href} exceeds ${maxBytes} bytes`,
          { url: raw, maxBytes, size: declared }
        )
      }
      let body: Uint8Array
      try {
        body = await readCapped(res, maxBytes, url.href)
      } catch (error) {
        if (error instanceof PayloadTooLargeError) throw error
        throw fail(
          `Could not read ${url.href}: ${
            signal.aborted
              ? `timed out after ${timeoutMs / 1000}s`
              : error instanceof Error
                ? error.message
                : String(error)
          }`,
          raw
        )
      }
      const header = String(res.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase()
      const filename = filenameOf(url)
      const guessed = filename ? contentTypeFromKey(filename) : undefined
      return {
        body,
        contentType:
          GENERIC_TYPES.has(header) && guessed
            ? guessed
            : header || "application/octet-stream",
        ...(filename && { filename }),
        finalUrl: url.href,
      }
    }
  }
}

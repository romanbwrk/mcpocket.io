import { EXTENSIONS } from "./kinds"

/**
 * RFC 2397 data URIs (`data:image/png;base64,iVBOR...`) — the way media is
 * embedded inside item JSON. Only URIs with an explicit `type/subtype` are
 * treated as media; `data:,text` is left alone.
 */

export type DataUriHeader = {
  contentType: string
  /** Optional `name=` / `filename=` parameter. */
  filename?: string
  base64: boolean
  /** Index of the comma that starts the data. */
  dataStart: number
}

const MAX_HEADER = 512
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/

/** Cheap test used while walking JSON (no decoding). */
export function parseDataUriHeader(value: string): DataUriHeader | null {
  if (!value.startsWith("data:")) return null
  const comma = value.indexOf(",", 5)
  if (comma < 0 || comma > MAX_HEADER) return null
  const [type, ...params] = value.slice(5, comma).split(";")
  if (!MIME.test(type)) return null
  let base64 = false
  let filename: string | undefined
  for (const param of params) {
    if (param.toLowerCase() === "base64") {
      base64 = true
      continue
    }
    const eq = param.indexOf("=")
    if (eq < 0) continue
    const key = param.slice(0, eq).trim().toLowerCase()
    if (key === "name" || key === "filename") {
      try {
        filename = decodeURIComponent(param.slice(eq + 1)) || undefined
      } catch {
        filename = param.slice(eq + 1) || undefined
      }
    }
  }
  return {
    contentType: type.toLowerCase(),
    ...(filename && { filename }),
    base64,
    dataStart: comma + 1,
  }
}

/** Decoded size without decoding (base64 → 3/4 of the length). */
export function estimateDataUriBytes(value: string, header: DataUriHeader) {
  const len = value.length - header.dataStart
  return header.base64 ? Math.floor((len * 3) / 4) : len
}

/** Bytes of a data URI, or `null` if its base64 / percent-encoding is invalid. */
export function decodeDataUri(
  value: string,
  header: DataUriHeader
): Buffer | null {
  const data = value.slice(header.dataStart)
  if (header.base64) {
    const compact = data.replace(/\s+/g, "")
    if (!BASE64.test(compact)) return null
    return Buffer.from(compact, "base64")
  }
  try {
    return Buffer.from(decodeURIComponent(data), "utf8")
  } catch {
    return null
  }
}

/** File extension for a MIME type (falls back to the filename's, then `bin`). */
export function extensionFor(contentType: string, filename?: string): string {
  const known = EXTENSIONS[contentType.toLowerCase()]
  if (known) return known
  const fromName = filename?.match(/\.([a-z0-9]{1,10})$/i)?.[1]
  return fromName?.toLowerCase() ?? "bin"
}

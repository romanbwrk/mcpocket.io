import type { PushItemInput } from "@mcpocket/core/services/items"

/**
 * Client-safe parsing of the tube view's "Import items" dialog. Accepted
 * input (pasted text or a .json / .jsonl file):
 *
 * - a JSON array of objects: `[{...}, {...}]`
 * - `{ "items": [...] }` (the REST bulk body)
 * - a single JSON object
 * - JSON Lines (one object per line)
 * - a plain list of values separated by commas or new lines (any text that
 *   does not start with `{` or `[`), e.g. `a@x.com, b@x.com`
 *
 * Plain values (list entries, or strings / numbers / booleans inside a JSON
 * array) become `{ "value": ... }` payloads, since payloads are objects.
 *
 * Each entry is either a raw payload (`{ "email": "..." }`) or a push
 * envelope (`{ "payload": {...}, "priority"?, "tags"?, "metadata"?,
 * "idempotencyKey"? }`) — an object is treated as an envelope when it has an
 * object `payload` and no keys outside the envelope fields. The server
 * validates every entry again (`services.items.bulkPush`).
 */

const ENVELOPE_KEYS = new Set([
  "payload",
  "priority",
  "tags",
  "metadata",
  "idempotencyKey",
])

/** Same cap as `MAX_BULK_ITEMS` on the server: entries per request. */
export const IMPORT_CHUNK_ITEMS = 500
/** Serialized size per request; below the 1 MB server action body limit. */
export const IMPORT_CHUNK_BYTES = 800 * 1024

/** Payload key that plain (non-object) values are wrapped under. */
export const PLAIN_VALUE_KEY = "value"

export type ImportParseResult =
  { ok: true; items: PushItemInput[] } | { ok: false; error: string }

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

function isEnvelope(entry: Record<string, unknown>): boolean {
  return (
    isObject(entry.payload) &&
    Object.keys(entry).every((key) => ENVELOPE_KEYS.has(key))
  )
}

/** Raw payload or push envelope → `PushItemInput`. */
export function toPushInput(entry: Record<string, unknown>): PushItemInput {
  return isEnvelope(entry) ? (entry as PushItemInput) : { payload: entry }
}

const isPlain = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean"

/** `a, b\nc` → `["a", "b", "c"]` (trimmed, empty entries dropped). */
export function splitPlainList(text: string): string[] {
  return text
    .split(/[,\r\n]+/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function parseJsonLines(text: string): unknown[] | string {
  const values: unknown[] = []
  const lines = text.split(/\r?\n/)
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue
    try {
      values.push(JSON.parse(line))
    } catch {
      return `Invalid JSON on line ${i + 1}`
    }
  }
  return values
}

/** JSON array / `{ items }` / single object / JSON Lines → entries or error. */
function parseJsonEntries(text: string): unknown[] | string {
  try {
    const value: unknown = JSON.parse(text)
    if (Array.isArray(value)) return value
    if (isObject(value) && Array.isArray(value.items)) return value.items
    return [value]
  } catch (error) {
    const lines = parseJsonLines(text)
    if (typeof lines !== "string") return lines
    return error instanceof Error ? error.message : "Invalid JSON"
  }
}

/** Text of the import dialog → push inputs, or a message explaining why not. */
export function parseImportText(text: string): ImportParseResult {
  if (!text.trim())
    return { ok: false, error: "Paste JSON, a list of values or choose a file" }

  const head = text.trimStart()[0]
  const entries =
    head === "{" || head === "[" ? parseJsonEntries(text) : splitPlainList(text)
  if (typeof entries === "string") return { ok: false, error: entries }

  if (entries.length === 0) return { ok: false, error: "No items to import" }
  const items: PushItemInput[] = []
  for (const [i, entry] of entries.entries()) {
    if (isPlain(entry)) {
      items.push({ payload: { [PLAIN_VALUE_KEY]: entry } })
      continue
    }
    if (!isObject(entry)) {
      return {
        ok: false,
        error: `Entry ${i + 1} is not a JSON object or value`,
      }
    }
    items.push(toPushInput(entry))
  }
  return { ok: true, items }
}

/**
 * Splits items into requests of at most `maxItems` entries and roughly
 * `maxBytes` of JSON each (a single oversized item still gets its own chunk;
 * the server then rejects it).
 */
export function chunkImportItems<T>(
  items: T[],
  maxItems = IMPORT_CHUNK_ITEMS,
  maxBytes = IMPORT_CHUNK_BYTES
): T[][] {
  const chunks: T[][] = []
  let current: T[] = []
  let size = 0
  for (const item of items) {
    const bytes = new TextEncoder().encode(JSON.stringify(item)).length + 1
    if (
      current.length > 0 &&
      (current.length >= maxItems || size + bytes > maxBytes)
    ) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += bytes
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

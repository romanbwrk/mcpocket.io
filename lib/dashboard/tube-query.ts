import {
  PAYLOAD_FILTER_OPERATORS,
  type PayloadFilterOperator,
} from "@mcpocket/core/domain/item-filter-operators"
import { ITEM_STATUSES, type ItemStatus } from "@mcpocket/core/domain/schemas"

/**
 * Tube view URL state (client-safe). The query string uses the same filter
 * format as `GET /api/tubes/{id}/items` (ticket 08): `status=a,b`,
 * `assignedAgent`, `createdFrom`/`createdTo`, `priority`/`priorityMin`/
 * `priorityMax`, `tags=a,b`, `payload.<path>[op]=value` — plus `page`
 * (1-based), `limit` (page size) and `item` (id of the item open in the
 * inspector, ticket 12). Parsing is lenient: unknown or malformed
 * values are dropped so a hand-edited URL never breaks the page; the service
 * validates the canonical result again.
 */

export const PAGE_SIZES = [25, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 25
/** Items fetched per infinite-scroll batch of the tube preview tab. */
export const PREVIEW_BATCH_SIZE = 20

export type PayloadFilterRow = {
  /** Dotted path into the payload (`customer.city`). */
  path: string
  op: PayloadFilterOperator
  /** Raw query value (`in` = comma list, `exists` = true|false). */
  value: string
}

export type TubeViewQuery = {
  status: ItemStatus[]
  assignedAgent?: string
  /** `YYYY-MM-DD` or ISO datetime (inclusive). */
  createdFrom?: string
  createdTo?: string
  priority?: number
  priorityMin?: number
  priorityMax?: number
  tags: string[]
  payload: PayloadFilterRow[]
  /** 1-based page number. */
  page: number
  limit: number
  /** Item open in the inspector (not a filter: kept across filter/page changes). */
  item?: string
}

export type SearchParamsRecord = Record<string, string | string[] | undefined>

export const EMPTY_TUBE_VIEW_QUERY: TubeViewQuery = {
  status: [],
  tags: [],
  payload: [],
  page: 1,
  limit: DEFAULT_PAGE_SIZE,
}

const PAYLOAD_KEY = /^payload\.(.+?)(?:\[([a-z]+)\])?$/
const PATH_RE = /^[^.\s]+(\.[^.\s]+)*$/
const ITEM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T.+)?$/

/** Next `searchParams` record → URLSearchParams (repeated keys kept). */
export function toURLSearchParams(
  input: SearchParamsRecord | URLSearchParams
): URLSearchParams {
  if (input instanceof URLSearchParams) return new URLSearchParams(input)
  const out = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) {
      out.append(key, one)
    }
  }
  return out
}

function list(params: URLSearchParams, key: string): string[] {
  return params
    .getAll(key)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean)
}

function text(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim()
  return value ? value : undefined
}

function int(params: URLSearchParams, key: string): number | undefined {
  const value = text(params, key)
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined
  return Number(value)
}

function date(params: URLSearchParams, key: string): string | undefined {
  const value = text(params, key)
  return value && DATE_RE.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : undefined
}

const isOperator = (op: string): op is PayloadFilterOperator =>
  (PAYLOAD_FILTER_OPERATORS as readonly string[]).includes(op)

/** Lenient URL → view state. */
export function parseTubeViewQuery(
  input: SearchParamsRecord | URLSearchParams
): TubeViewQuery {
  const params = toURLSearchParams(input)
  const statuses = new Set(list(params, "status"))
  const payload: PayloadFilterRow[] = []
  for (const key of new Set(params.keys())) {
    const match = PAYLOAD_KEY.exec(key)
    if (!match) continue
    const [, path, op = "eq"] = match
    if (!PATH_RE.test(path) || !isOperator(op)) continue
    for (const value of params.getAll(key)) {
      if (value === "" && op !== "exists") continue
      payload.push({ path, op, value })
    }
  }
  const page = int(params, "page")
  const limit = int(params, "limit")
  return {
    status: ITEM_STATUSES.filter((s) => statuses.has(s)),
    assignedAgent: text(params, "assignedAgent"),
    createdFrom: date(params, "createdFrom"),
    createdTo: date(params, "createdTo"),
    priority: int(params, "priority"),
    priorityMin: int(params, "priorityMin"),
    priorityMax: int(params, "priorityMax"),
    tags: [...new Set(list(params, "tags"))],
    payload,
    page: page && page > 0 ? page : 1,
    limit: (PAGE_SIZES as readonly number[]).includes(limit ?? 0)
      ? (limit as number)
      : DEFAULT_PAGE_SIZE,
    item: ITEM_ID_RE.test(text(params, "item") ?? "")
      ? text(params, "item")
      : undefined,
  }
}

/** Filter-only query params (no `page`/`limit`), in canonical order. */
export function filterSearchParams(query: TubeViewQuery): URLSearchParams {
  const out = new URLSearchParams()
  if (query.status.length) out.set("status", query.status.join(","))
  if (query.assignedAgent) out.set("assignedAgent", query.assignedAgent)
  if (query.createdFrom) out.set("createdFrom", query.createdFrom)
  if (query.createdTo) out.set("createdTo", query.createdTo)
  for (const key of ["priority", "priorityMin", "priorityMax"] as const) {
    if (query[key] !== undefined) out.set(key, String(query[key]))
  }
  if (query.tags.length) out.set("tags", query.tags.join(","))
  for (const row of query.payload) {
    const key =
      row.op === "eq" ? `payload.${row.path}` : `payload.${row.path}[${row.op}]`
    out.append(key, row.value)
  }
  return out
}

/**
 * Canonical query string (defaults omitted), without the leading `?`.
 * `withItem: false` drops the inspector param (Suspense keys of the list).
 */
export function tubeViewSearch(
  query: TubeViewQuery,
  { withItem = true }: { withItem?: boolean } = {}
): string {
  const out = filterSearchParams(query)
  if (query.page > 1) out.set("page", String(query.page))
  if (query.limit !== DEFAULT_PAGE_SIZE) out.set("limit", String(query.limit))
  if (withItem && query.item) out.set("item", query.item)
  return out.toString()
}

/**
 * `pathname?query` for a patched view state. Filter changes reset to page 1;
 * `{ item: id | undefined }` opens / closes the inspector.
 */
export function tubeViewHref(
  pathname: string,
  query: TubeViewQuery,
  patch: Partial<TubeViewQuery> = {}
): string {
  const filterChanged = Object.keys(patch).some(
    (k) => k !== "page" && k !== "limit" && k !== "item"
  )
  const next: TubeViewQuery = {
    ...query,
    ...(filterChanged || patch.limit !== undefined ? { page: 1 } : {}),
    ...patch,
  }
  const search = tubeViewSearch(next)
  return search ? `${pathname}?${search}` : pathname
}

/** Number of active filters (for the "N filters" hint). */
export function activeFilterCount(query: TubeViewQuery): number {
  return (
    (query.status.length ? 1 : 0) +
    (query.assignedAgent ? 1 : 0) +
    (query.createdFrom ? 1 : 0) +
    (query.createdTo ? 1 : 0) +
    (query.priority !== undefined ? 1 : 0) +
    (query.priorityMin !== undefined ? 1 : 0) +
    (query.priorityMax !== undefined ? 1 : 0) +
    (query.tags.length ? 1 : 0) +
    query.payload.length
  )
}

import { isDeepStrictEqual } from "node:util"

import { z } from "zod"

import { PAYLOAD_FILTER_OPERATORS } from "./item-filter-operators"
import { ItemStatusSchema, type Item } from "./schemas"

/**
 * Item search filters (plan §8.2), shared by REST (`GET /api/tubes/{id}/items`
 * query params), MCP (`search_items`) and the dashboard. Filters are evaluated
 * in memory over a tube's items (`matchesItemFilter`), then paginated.
 */

/** Splits a comma list / accepts an array; empty entries are dropped. */
function listOf<T extends z.ZodType>(element: T, label: string) {
  return z.union([z.string(), z.array(z.string())]).transform((v, ctx) => {
    const list = (Array.isArray(v) ? v : v.split(","))
      .map((s) => s.trim())
      .filter(Boolean)
    const parsed = z.array(element).safeParse(list)
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: `Invalid ${label} filter` })
      return z.NEVER
    }
    return parsed.data as z.output<T>[]
  })
}

/** One status, an array or a comma list (`pending,retry`). */
export const StatusFilterSchema = listOf(ItemStatusSchema, "status")

export {
  PAYLOAD_FILTER_OPERATORS,
  type PayloadFilterOperator,
} from "./item-filter-operators"

export const PATH_RE = /^[^.\s]+(\.[^.\s]+)*$/

/** `{ path: "customer.address.city", op: "eq", value: "Berlin" }` */
export const PayloadConditionSchema = z
  .strictObject({
    /** Dotted path into the payload; numeric segments index arrays (`lines.0.sku`). */
    path: z
      .string()
      .max(500)
      .regex(PATH_RE, "Expected a dotted path like a.b.c"),
    op: z.enum(PAYLOAD_FILTER_OPERATORS).default("eq"),
    /** Compared value: an array for `in`, a boolean for `exists` (default true). */
    value: z.unknown().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.op === "in" && !Array.isArray(c.value)) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "`in` needs an array value",
      })
    } else if (
      c.op === "exists" &&
      c.value !== undefined &&
      typeof c.value !== "boolean"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "`exists` needs a boolean value",
      })
    } else if (c.op !== "exists" && c.value === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `\`${c.op}\` needs a value`,
      })
    }
  })
export type PayloadCondition = z.output<typeof PayloadConditionSchema>

const DateBoundSchema = z.union([
  z.iso.datetime({ offset: true }),
  z.iso.date(),
])

const IntQuerySchema = z.coerce.number().int()

/** Item filters; every given filter must match (AND). */
export const ItemFilterSchema = z.object({
  /** One status, an array or a comma list. */
  status: StatusFilterSchema.optional(),
  /** Exact `assignedAgent`. */
  assignedAgent: z.string().trim().min(1).max(128).optional(),
  /** `createdAt >= createdFrom` (ISO datetime, or a date = start of that UTC day). */
  createdFrom: DateBoundSchema.optional(),
  /** `createdAt <= createdTo` (ISO datetime, or a date = end of that UTC day). */
  createdTo: DateBoundSchema.optional(),
  /** Exact priority. */
  priority: IntQuerySchema.optional(),
  priorityMin: IntQuerySchema.optional(),
  priorityMax: IntQuerySchema.optional(),
  /** Item must carry ALL these tags (array or comma list). */
  tags: listOf(z.string().min(1).max(100), "tags").optional(),
  /** Payload field conditions (AND). */
  payload: z.array(PayloadConditionSchema).max(50).optional(),
})
export type ItemFilterInput = z.input<typeof ItemFilterSchema>
export type ItemFilter = z.output<typeof ItemFilterSchema>

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function boundTime(value: string, end: boolean): number {
  if (DATE_ONLY.test(value)) {
    return Date.parse(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`)
  }
  return Date.parse(value)
}

/** Resolves a dotted path (`a.b.0.c`); `undefined` when any segment is missing. */
export function getPath(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined
      current = current[Number(segment)]
    } else if (current !== null && typeof current === "object") {
      if (!Object.hasOwn(current, segment)) return undefined
      current = (current as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return current
}

const isScalar = (v: unknown) =>
  v === null || ["string", "number", "boolean"].includes(typeof v)

/** Deep equality; scalars also match by string form (`"42"` equals `42`). */
function looseEqual(actual: unknown, expected: unknown): boolean {
  if (isDeepStrictEqual(actual, expected)) return true
  return (
    actual !== undefined &&
    isScalar(actual) &&
    isScalar(expected) &&
    String(actual) === String(expected)
  )
}

/** Numbers compare numerically (numeric strings are coerced), strings lexically. */
function compare(actual: unknown, expected: unknown): number | undefined {
  if (typeof actual === "number") {
    const n = typeof expected === "number" ? expected : Number(expected)
    if (typeof expected === "string" && expected.trim() === "") return undefined
    return Number.isNaN(n) ? undefined : actual - n
  }
  if (typeof actual === "string" && isScalar(expected) && expected !== null) {
    const e = String(expected)
    return actual < e ? -1 : actual > e ? 1 : 0
  }
  return undefined
}

export function matchesCondition(
  payload: unknown,
  { path, op, value }: PayloadCondition
): boolean {
  const actual = getPath(payload, path)
  switch (op) {
    case "eq":
      return looseEqual(actual, value)
    case "ne":
      return !looseEqual(actual, value)
    case "in":
      return (value as unknown[]).some((v) => looseEqual(actual, v))
    case "exists":
      return (actual !== undefined) === (value ?? true)
    case "contains":
      if (typeof actual === "string" && isScalar(value) && value !== null) {
        return actual.toLowerCase().includes(String(value).toLowerCase())
      }
      if (Array.isArray(actual)) return actual.some((v) => looseEqual(v, value))
      return false
    default: {
      const c = compare(actual, value)
      if (c === undefined) return false
      if (op === "gt") return c > 0
      if (op === "gte") return c >= 0
      if (op === "lt") return c < 0
      return c <= 0
    }
  }
}

/** True when `item` satisfies every filter in `filter`. */
export function matchesItemFilter(item: Item, filter: ItemFilter): boolean {
  if (filter.status?.length && !filter.status.includes(item.status)) {
    return false
  }
  if (
    filter.assignedAgent !== undefined &&
    item.assignedAgent !== filter.assignedAgent
  ) {
    return false
  }
  const created = Date.parse(item.createdAt)
  if (filter.createdFrom && created < boundTime(filter.createdFrom, false)) {
    return false
  }
  if (filter.createdTo && created > boundTime(filter.createdTo, true)) {
    return false
  }
  if (filter.priority !== undefined && item.priority !== filter.priority) {
    return false
  }
  if (filter.priorityMin !== undefined && item.priority < filter.priorityMin) {
    return false
  }
  if (filter.priorityMax !== undefined && item.priority > filter.priorityMax) {
    return false
  }
  if (filter.tags?.some((tag) => !item.tags.includes(tag))) return false
  if (filter.payload?.some((c) => !matchesCondition(item.payload, c))) {
    return false
  }
  return true
}

/** True when the filter restricts anything (otherwise repo counts suffice). */
export function hasItemFilter(filter: ItemFilter): boolean {
  return Object.values(filter).some((v) =>
    Array.isArray(v) ? v.length > 0 : v !== undefined
  )
}

const QUERY_PAYLOAD_KEY = /^payload\.(.+?)(?:\[([a-z]+)\])?$/

/** Query-string value → typed JSON value (`42`, `true`, `null`), else the raw string. */
function parseQueryValue(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isScalar(parsed) ? parsed : raw
  } catch {
    return raw
  }
}

/**
 * Turns REST query params into service input: `payload.<path>=v` (equality)
 * and `payload.<path>[op]=v` keys become `payload` conditions (`in` takes a
 * comma list, `exists` takes `true|false`); every other key passes through.
 */
export function itemQueryFromSearchParams(
  query: Record<string, string | string[]>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const payload: Array<Record<string, unknown>> = []
  for (const [key, raw] of Object.entries(query)) {
    const match = QUERY_PAYLOAD_KEY.exec(key)
    if (!match) {
      out[key] = raw
      continue
    }
    const [, path, op = "eq"] = match
    for (const one of Array.isArray(raw) ? raw : [raw]) {
      let value: unknown
      if (op === "in")
        value = one.split(",").map((s) => parseQueryValue(s.trim()))
      else if (op === "exists") value = one === "" ? true : parseQueryValue(one)
      else value = parseQueryValue(one)
      payload.push({ path, op, value })
    }
  }
  if (payload.length > 0) out.payload = payload
  return out
}

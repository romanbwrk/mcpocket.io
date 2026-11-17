import { z } from "zod"

export const DEFAULT_PAGE_LIMIT = 100
export const MAX_PAGE_LIMIT = 1000

/** Pagination input shared by every list operation. Coerces query-string values. */
export const PageInputSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT),
})
export type PageInput = z.input<typeof PageInputSchema>

/** Shape returned by every paginated list operation (and REST list endpoint). */
export type PageResult<T> = {
  data: T[]
  page: { offset: number; limit: number; total: number }
}

/** List order by `createdAt`: `asc` (oldest first, default) or `desc` (newest first). */
export const SortOrderSchema = z.enum(["asc", "desc"]).default("asc")
export type SortOrder = z.output<typeof SortOrderSchema>

/** One page of an in-memory list (in `asc` order) for `order`. */
export function pageOf<T>(
  all: readonly T[],
  { offset, limit, order }: { offset: number; limit: number; order: SortOrder }
): T[] {
  const ordered = order === "desc" ? [...all].reverse() : all
  return ordered.slice(offset, offset + limit)
}

/**
 * Storage `offset`/`limit` (over the `asc` order) that hold the `desc` page
 * `offset`/`limit` of `total` entries; reverse the rows read with them.
 */
export function descWindow(
  total: number,
  offset: number,
  limit: number
): { offset: number; limit: number } {
  const end = Math.max(0, total - offset)
  const start = Math.max(0, end - limit)
  return { offset: start, limit: end - start }
}

import { z } from "zod"

import { ValidationError } from "../../domain/errors"
import { getPath, PATH_RE } from "../../domain/item-filter"
import type { PageResult } from "../../domain/pagination"

/**
 * Output options of the item read tools (MCP only): they trim what an agent
 * gets back, so it does not spend context on fields it never reads. Filtering,
 * paging and ordering are the services' job; these only reshape the result.
 */

const FieldPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(PATH_RE, "Expected a dotted path like payload.prompt")

/** `fields` / `field`: shared by every item read tool. */
export const ItemProjectionSchema = z.object({
  fields: z
    .array(FieldPathSchema)
    .min(1)
    .max(50)
    .optional()
    .describe(
      'Return only these item fields: dotted paths such as ["id", "status", "payload.prompt", "result.url"]; numeric segments index arrays. Each item becomes an object holding just those paths (nested as in the item); missing paths are left out.'
    ),
  field: FieldPathSchema.optional().describe(
    'Return only this one field\'s value, e.g. "payload.prompt": data holds the bare value (null when missing) instead of an object. Cannot be combined with fields.'
  ),
})

/** `ItemProjectionSchema` plus `countOnly`, for the paginated list tools. */
export const ItemListOutputSchema = ItemProjectionSchema.extend({
  countOnly: z
    .boolean()
    .optional()
    .describe(
      "Return only { total } (the number of matching items), no items. Ignores offset/limit/fields."
    ),
})

/** Names of the output options, removed before the arguments reach a service. */
const OUTPUT_KEYS = ["fields", "field", "countOnly"] as const

export type ItemProjection = z.output<typeof ItemProjectionSchema>
type ItemListOutput = z.output<typeof ItemListOutputSchema>

/**
 * Splits tool arguments into the service input and the output options;
 * throws `ZodError` / `ValidationError` (→ validation_error) on bad options.
 */
export function splitOutputOptions(args: Record<string, unknown>): {
  input: Record<string, unknown>
  output: ItemListOutput
} {
  const input = { ...args }
  const raw: Record<string, unknown> = {}
  for (const key of OUTPUT_KEYS) {
    if (key in input) {
      raw[key] = input[key]
      delete input[key]
    }
  }
  const output = ItemListOutputSchema.parse(raw)
  if (output.fields && output.field !== undefined) {
    throw new ValidationError("Pass either fields or field, not both")
  }
  return { input, output }
}

const isContainer = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object"

/** Copies `path` of `source` into `target`, creating parents on the way. */
function copyPath(
  target: Record<string, unknown>,
  source: unknown,
  path: string
) {
  const value = getPath(source, path)
  if (value === undefined) return
  const segments = path.split(".")
  let node = target
  for (const segment of segments.slice(0, -1)) {
    if (!isContainer(node[segment])) node[segment] = {}
    node = node[segment] as Record<string, unknown>
  }
  node[segments[segments.length - 1]] = value
}

/** One item (or any JSON object) reshaped by `fields` / `field`. */
export function projectItem(item: unknown, { fields, field }: ItemProjection) {
  if (field !== undefined) return getPath(item, field) ?? null
  if (!fields) return item
  const out: Record<string, unknown> = {}
  for (const path of fields) copyPath(out, item, path)
  return out
}

export const hasProjection = ({ fields, field }: ItemProjection) =>
  fields !== undefined || field !== undefined

/** A page of items reshaped by the output options. */
export function shapePage<T>(
  page: PageResult<T>,
  output: ItemListOutput
): PageResult<unknown> | { total: number } {
  if (output.countOnly) return { total: page.page.total }
  if (!hasProjection(output)) return page
  return { ...page, data: page.data.map((item) => projectItem(item, output)) }
}

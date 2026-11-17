import { itemQueryFromSearchParams } from "@mcpocket/core/domain/item-filter"

import { filterSearchParams, type TubeViewQuery } from "./tube-query"

/**
 * Tube view state → `services.items.list(tubeId, input)` input. Goes through
 * the REST query format (`filterSearchParams`) and the same
 * `itemQueryFromSearchParams` the REST route uses, so the dashboard and
 * `GET /api/tubes/{id}/items?...` always agree on a given query string.
 */
export function tubeItemsListInput(
  query: TubeViewQuery
): Record<string, unknown> {
  const params = filterSearchParams(query)
  const record: Record<string, string | string[]> = {}
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key)
    record[key] = values.length > 1 ? values : values[0]
  }
  return {
    ...itemQueryFromSearchParams(record),
    offset: (query.page - 1) * query.limit,
    limit: query.limit,
  }
}

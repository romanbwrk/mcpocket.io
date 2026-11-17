import {
  apiHandler,
  created,
  queryObject,
  readJsonBody,
} from "@mcpocket/core/api/handler"
import { itemQueryFromSearchParams } from "@mcpocket/core/domain/item-filter"

type Params = { id: string }

/**
 * GET /api/tubes/{id}/items?offset=&limit=&includeDeleted=true — createdAt
 * ascending. Filters: status (comma list), assignedAgent, createdFrom,
 * createdTo, priority, priorityMin, priorityMax, tags (comma list, all of),
 * `payload.<dotted.path>=value` and `payload.<path>[op]=value` (ops in
 * `lib/domain/item-filter.ts`). `page.total` counts all matches.
 */
export const GET = apiHandler<Params>(({ services, params, url }) =>
  services.items.list(params.id, itemQueryFromSearchParams(queryObject(url)))
)

/**
 * POST /api/tubes/{id}/items { payload, priority?, tags?, metadata?, idempotencyKey? }
 * → 201 { data } for a new item; 200 { data } with the original item when
 * the idempotency key was already used in this tube.
 */
export const POST = apiHandler<Params>(
  async ({ services, params, request }) => {
    const { item, created: isNew } = await services.items.push(
      params.id,
      await readJsonBody(request)
    )
    return isNew ? created({ data: item }) : { data: item }
  }
)

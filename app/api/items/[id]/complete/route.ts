import { apiHandler, readJsonBody } from "@mcpocket/core/api/handler"

type Params = { id: string }

/**
 * POST /api/items/{id}/complete { result?, next? } — sets `completed`,
 * `result`, `completedAt` — lease owner only (`X-Agent-Id`): other agent →
 * 403, expired lease or item not processing → 409.
 *
 * `next`: one or a list of `{ tubeId, payload, priority?, tags?, metadata?,
 * idempotencyKey? }` pushed into other tubes in the same atomic write (each
 * gets `metadata.source = { tubeId, itemId }`). Media data URIs in `result`
 * and `next` are uploaded to S3 first. → 200 { data: Item, next?: Item[] }.
 */
export const POST = apiHandler<Params>(
  async ({ services, params, request }) => {
    const { item, next } = await services.processing.completeWithNext(
      params.id,
      await readJsonBody(request)
    )
    return { data: item, ...(next.length > 0 && { next }) }
  }
)

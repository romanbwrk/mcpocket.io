import { apiHandler, readJsonBody } from "@mcpocket/core/api/handler"

/**
 * POST /api/items/claim { tubeId, leaseSeconds? } — requires `X-Agent-Id`.
 * 200 `{ claimed: true, data: item, claim: { itemId, agentId, claimedAt,
 * leaseExpiresAt, attempts } }`, or `{ claimed: false, data: null, message }`
 * when the tube has nothing to claim.
 */
export const POST = apiHandler(async ({ services, request }) => {
  const result = await services.processing.claim(await readJsonBody(request))
  if (!result) {
    return { claimed: false, data: null, message: "Nothing to claim" }
  }
  return { claimed: true, data: result.item, claim: result.claim }
})

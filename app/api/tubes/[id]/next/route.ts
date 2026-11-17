import { apiHandler } from "@mcpocket/core/api/handler"
import type { Actor } from "@mcpocket/core/domain/actor"
import { getServices, publicUrlFor } from "@mcpocket/core/services"

type Params = { id: string }

const NO_STORE = { "cache-control": "no-store" }

/** Payload → response body: a lone field is unwrapped. */
function payloadResponse(payload: Record<string, unknown>): Response {
  const keys = Object.keys(payload)
  if (keys.length !== 1) return Response.json(payload, { headers: NO_STORE })
  const value = payload[keys[0]]
  if (typeof value === "string") {
    return new Response(value, {
      headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" },
    })
  }
  return Response.json(value ?? null, { headers: NO_STORE })
}

/**
 * The agent a primitive GET claims as: the request's agent (`X-Agent-Id`,
 * `?agent_id=` or the key's bound agent), else one named after the key.
 */
function claimingActor(actor: Actor): Actor {
  if (actor.kind !== "api_key") return actor
  return { ...actor, kind: "agent", viaKeyId: actor.id }
}

/**
 * GET /api/tubes/{id}/next — primitive queue pop for clients that can only
 * fetch a URL (`?api_key=<secret>`, optional `&agent_id=`). Every call takes
 * the next claimable item of the tube (same order as `claim_next_item`),
 * marks it `completed` and returns only its payload JSON object — or, when
 * the payload has a single field, just that field's value (strings as plain
 * text, anything else as JSON). 204 (empty body) when there is nothing to take.
 */
export const GET = apiHandler<Params>(
  async ({ actor, params, request, services: base }) => {
    const agent = claimingActor(actor)
    const services =
      agent === actor
        ? base
        : await getServices(agent, { publicUrl: publicUrlFor(request) })

    const claimed = await services.processing.claim({ tubeId: params.id })
    if (!claimed) return new Response(null, { status: 204, headers: NO_STORE })
    const item = await services.processing.complete(claimed.item.id)
    return payloadResponse(item.payload)
  }
)

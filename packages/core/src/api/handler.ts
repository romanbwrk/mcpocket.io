import { AUTH_QUERY_PARAMS, authorizeRequest } from "./auth"
import { toErrorResponse } from "./errors"
import { withRateLimitHeaders } from "./rate-limit"
import type { Actor } from "../domain/actor"
import { PayloadTooLargeError, ValidationError } from "../domain/errors"
import { getServices, publicUrlFor, type Services } from "../services"

export type ApiContext<P> = {
  request: Request
  url: URL
  params: P
  actor: Actor
  services: Services
}

type RouteContext<P> = { params: Promise<P> }

/**
 * Wraps a route handler with the shared REST pipeline: API-key auth →
 * per-key rate limit (429 + `RateLimit-*` headers) → actor (role/scope) →
 * services bound to the actor (which enforce permissions) → handler → error
 * mapping. Handlers
 * return plain data (sent as 200 JSON) or a `Response` for other statuses.
 *
 *   export const GET = apiHandler(({ services }) => services.folders.tree())
 */
export function apiHandler<
  P extends Record<string, string | string[]> = Record<string, never>,
>(handler: (ctx: ApiContext<P>) => Promise<unknown> | unknown) {
  return async (
    request: Request,
    context?: RouteContext<P>
  ): Promise<Response> => {
    let rateLimit: Awaited<ReturnType<typeof authorizeRequest>>["rateLimit"] =
      null
    try {
      const authorized = await authorizeRequest(request)
      rateLimit = authorized.rateLimit
      const actor = authorized.principal.actor
      const params = ((await context?.params) ?? {}) as P
      const services = await getServices(actor, {
        publicUrl: publicUrlFor(request),
      })
      const result = await handler({
        request,
        url: new URL(request.url),
        params,
        actor,
        services,
      })
      return withRateLimitHeaders(
        result instanceof Response ? result : Response.json(result),
        rateLimit
      )
    } catch (error) {
      return withRateLimitHeaders(toErrorResponse(error), rateLimit)
    }
  }
}

/**
 * Parses a JSON request body (400 on malformed JSON; 413 when larger than
 * `maxBytes`, if given). Validate it in the service.
 */
export async function readJsonBody(
  request: Request,
  options: { maxBytes?: number } = {}
): Promise<unknown> {
  const { maxBytes } = options
  const declared = Number(request.headers.get("content-length"))
  if (maxBytes !== undefined && declared > maxBytes) {
    throw new PayloadTooLargeError(`Request body exceeds ${maxBytes} bytes`, {
      maxBytes,
    })
  }
  const text = await request.text()
  if (maxBytes !== undefined && Buffer.byteLength(text) > maxBytes) {
    throw new PayloadTooLargeError(`Request body exceeds ${maxBytes} bytes`, {
      maxBytes,
    })
  }
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ValidationError("Request body is not valid JSON")
  }
}

/**
 * Query string → plain object (repeated keys become arrays). The literal
 * values `null` / `root` are kept as strings; endpoints decide their meaning.
 * The `api_key` / `agent_id` auth parameters are left out.
 */
export function queryObject(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const key of new Set(url.searchParams.keys())) {
    if (AUTH_QUERY_PARAMS.includes(key)) continue
    const values = url.searchParams.getAll(key)
    out[key] = values.length > 1 ? values : values[0]
  }
  return out
}

export const created = (data: unknown) => Response.json(data, { status: 201 })
export const noContent = () => new Response(null, { status: 204 })

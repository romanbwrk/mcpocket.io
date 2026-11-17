import { getStorage } from "@mcpocket/core/storage"

/**
 * Liveness/readiness probe for Docker / load balancers. Unauthenticated and
 * deliberately minimal: it only says whether the server is up and the
 * storage loaded — no counts, versions, paths or error details.
 */
export async function GET(): Promise<Response> {
  let storage: "ok" | "error" = "ok"
  try {
    await getStorage()
  } catch {
    storage = "error"
  }
  const ok = storage === "ok"
  return Response.json(
    { status: ok ? "ok" : "error", checks: { storage } },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } }
  )
}

export async function HEAD(): Promise<Response> {
  const response = await GET()
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  })
}

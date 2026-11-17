import {
  adminConfigFromEnv,
  SESSION_COOKIE,
  verifySessionToken,
} from "../auth/session"
import { roleHasCapability } from "../domain/access"
import { RateLimitedError } from "../domain/errors"
import { verifyMediaSignature, type MediaAccess } from "../media/links"
import { actorWorkspace } from "../workspace"

import { authenticatePrincipal, enforceRateLimit } from "./auth"

export type MediaGrant =
  | {
      ok: true
      via: "public" | "signed" | "session" | "api_key"
      expires?: number
    }
  | { ok: false; rateLimited?: true }

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=")
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return null
}

/**
 * May this request read media object `key`? In `private` mode: a valid
 * signed link, a dashboard session cookie, or an API key with `read`
 * (rate-limited like any API call). Never throws for bad credentials.
 * `workspace` (multi-workspace mode): the object's workspace — sessions and
 * API keys of other workspaces are refused.
 */
export async function authorizeMediaRequest(
  request: Request,
  key: string,
  access: MediaAccess,
  now: Date = new Date(),
  workspace?: string
): Promise<MediaGrant> {
  if (access === "public") return { ok: true, via: "public" }
  const url = new URL(request.url)
  const exp = url.searchParams.get("exp")
  if (
    verifyMediaSignature(
      key,
      exp,
      url.searchParams.get("sig"),
      Math.floor(now.getTime() / 1000)
    )
  ) {
    return { ok: true, via: "signed", expires: Number(exp) }
  }
  const session = verifySessionToken(
    adminConfigFromEnv(),
    cookie(request, SESSION_COOKIE),
    now
  )
  if (session && (!workspace || actorWorkspace(session.ws) === workspace)) {
    return { ok: true, via: "session" }
  }
  if (
    request.headers.has("authorization") ||
    request.headers.has("x-api-key")
  ) {
    try {
      const principal = await authenticatePrincipal(request)
      const role = principal.actor.access?.role ?? "admin"
      if (!roleHasCapability(role, "read")) return { ok: false }
      if (workspace && principal.actor.workspace !== workspace) {
        return { ok: false }
      }
      enforceRateLimit(principal)
      return { ok: true, via: "api_key" }
    } catch (error) {
      if (error instanceof RateLimitedError)
        return { ok: false, rateLimited: true }
      return { ok: false }
    }
  }
  return { ok: false }
}

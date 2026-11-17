import { startSsoSession } from "@/lib/auth/server"
import { safeRedirectPath } from "@mcpocket/core/auth/session"
import { ssoConfigFromEnv, verifySsoToken } from "@mcpocket/core/auth/sso"

/**
 * GET|POST /auth/sso?token=<jwt>[&next=/dashboard/...] — SSO token login.
 *
 * A trusted issuer (MCPocket Cloud, or your own identity provider) sends the
 * browser here with a short-lived HS256 token signed with
 * `MCPOCKET_SSO_SECRET` (see `@mcpocket/core/auth/sso`). A valid token sets
 * the same signed session cookie as password login (username = the email)
 * and redirects to `/dashboard` or a safe `next` path; an invalid one
 * redirects to `/auth/sso/error?reason=<code>` without creating a session.
 * POST accepts the same fields as a form body (keeps the token out of
 * access logs). 404 while `MCPOCKET_SSO_SECRET` is unset.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  return handle(params.get("token"), params.get("next"))
}

export async function POST(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  let form: FormData | null = null
  try {
    form = await request.formData()
  } catch {
    form = null
  }
  const field = (name: string) => {
    const value = form?.get(name)
    return typeof value === "string" ? value : params.get(name)
  }
  return handle(field("token"), field("next"))
}

const NO_STORE = {
  "Cache-Control": "no-store",
  // The token is in the URL: never leak it to the next page's referrer.
  "Referrer-Policy": "no-referrer",
}

/** Relative `Location`, so redirects work behind any reverse proxy. */
const seeOther = (location: string) =>
  new Response(null, {
    status: 303,
    headers: { Location: location, ...NO_STORE },
  })

async function handle(
  token: string | null,
  next: string | null
): Promise<Response> {
  const config = ssoConfigFromEnv()
  if (!config) {
    return new Response("Not Found", { status: 404, headers: NO_STORE })
  }
  const result = verifySsoToken(config, token)
  if (!result.ok) {
    return seeOther(`/auth/sso/error?reason=${result.reason}`)
  }
  await startSsoSession(result.email, result.claims.ws)
  return seeOther(safeRedirectPath(next))
}

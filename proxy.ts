import { NextResponse, type NextRequest } from "next/server"

import {
  isSelfRedirect,
  loginModeFromEnv,
  ssoLoginRedirectUrl,
} from "@mcpocket/core/auth/login-mode"
import {
  adminConfigFromEnv,
  SESSION_COOKIE,
  verifySessionToken,
} from "@mcpocket/core/auth/session"

/**
 * Optimistic dashboard auth: redirects anonymous visitors of /dashboard to
 * /login (keeping the target in `?next=`) and logged-in admins away from
 * /login. With `MCPOCKET_SSO_LOGIN_URL` set (SSO-only mode), anonymous
 * visitors of /dashboard and /login go to that URL instead, carrying the
 * requested dashboard path as `?next=`. Real checks happen in the DAL
 * (lib/auth/server.ts) on every server component render and server action.
 */
export default function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const session = verifySessionToken(
    adminConfigFromEnv(),
    request.cookies.get(SESSION_COOKIE)?.value
  )

  if (!session) {
    const { ssoLoginUrl } = loginModeFromEnv()
    if (ssoLoginUrl && !isSelfRedirect(ssoLoginUrl, request.nextUrl)) {
      if (pathname.startsWith("/dashboard")) {
        return NextResponse.redirect(
          ssoLoginRedirectUrl(ssoLoginUrl, `${pathname}${search}`)
        )
      }
      if (pathname === "/login") {
        return NextResponse.redirect(
          ssoLoginRedirectUrl(
            ssoLoginUrl,
            request.nextUrl.searchParams.get("next")
          )
        )
      }
    }
  }

  if (pathname.startsWith("/dashboard") && !session) {
    const url = new URL("/login", request.nextUrl)
    url.searchParams.set("next", `${pathname}${search}`)
    return NextResponse.redirect(url)
  }
  if (pathname === "/login" && session) {
    return NextResponse.redirect(new URL("/dashboard", request.nextUrl))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ["/dashboard/:path*", "/login"],
}

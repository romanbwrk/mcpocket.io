import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { BrandPanel } from "@/components/brand-panel"
import { ThemeToggle } from "@/components/theme-toggle"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { loginModeFromEnv, signInUrl } from "@mcpocket/core/auth/login-mode"
import {
  isSsoErrorCode,
  SSO_ERROR_MESSAGES,
  ssoConfigFromEnv,
} from "@mcpocket/core/auth/sso"

export const metadata: Metadata = { title: "Sign-in failed" }

/** Rejected SSO login (`/auth/sso` redirects here with `?reason=<code>`). */
export default async function SsoErrorPage({
  searchParams,
}: PageProps<"/auth/sso/error">) {
  if (!ssoConfigFromEnv()) notFound()
  const { reason } = await searchParams
  // Back to sign in: the SSO login URL when configured, else /login.
  const signInHref = signInUrl(loginModeFromEnv())
  const message = isSsoErrorCode(reason)
    ? SSO_ERROR_MESSAGES[reason]
    : {
        title: "Sign-in did not complete",
        detail: "The sign-in link could not be used.",
      }

  return (
    <main className="relative flex min-h-svh items-center justify-center p-6">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
      <div className="grid w-full max-w-4xl items-center gap-10 md:grid-cols-2">
        <BrandPanel />
        <Card>
          <CardHeader>
            <CardTitle>{message.title}</CardTitle>
            <CardDescription>You have not been signed in.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-4">
            <p className="text-xs text-muted-foreground">{message.detail}</p>
            <a
              href={signInHref}
              className={buttonVariants({ variant: "outline" })}
            >
              Back to sign in
            </a>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

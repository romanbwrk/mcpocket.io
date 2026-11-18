import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { BrandPanel } from "@/components/brand-panel"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getSession } from "@/lib/auth/server"
import { loginModeFromEnv } from "@mcpocket/core/auth/login-mode"
import {
  adminConfigFromEnv,
  isAdminConfigured,
  safeRedirectPath,
} from "@mcpocket/core/auth/session"
import { ssoConfigFromEnv } from "@mcpocket/core/auth/sso"

import { LoginForm } from "./login-form"

export const metadata: Metadata = { title: "Sign in" }

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams
  if (await getSession()) redirect(safeRedirectPath(next))
  // With MCPOCKET_SSO_LOGIN_URL set, proxy.ts sends anonymous visitors there
  // before this page renders.
  const mode = loginModeFromEnv()
  const configured = isAdminConfigured(adminConfigFromEnv())
  const ssoEnabled = ssoConfigFromEnv() !== null
  // Cloud mode: sign-in happens on the control plane, so there is nothing
  // to do here — send the visitor home.
  if (!configured && ssoEnabled) redirect("/")

  return (
    <main className="relative flex min-h-svh items-center justify-center p-6">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
      <div className="grid w-full max-w-4xl items-center gap-10 md:grid-cols-2">
        <BrandPanel />
        <Card>
          <CardHeader>
            <CardTitle>Sign in to the dashboard</CardTitle>
            <CardDescription>Administrator access</CardDescription>
          </CardHeader>
          <CardContent>
            {configured ? (
              <LoginForm next={safeRedirectPath(next, "") || undefined} />
            ) : !mode.passwordLogin ? (
              <SsoMisconfiguredNotice />
            ) : (
              <SetupNotice />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

function SetupNotice() {
  return (
    <div className="flex flex-col gap-3 text-xs">
      <p className="font-medium">Dashboard login is not configured yet.</p>
      <p className="text-muted-foreground">
        Set the admin credentials in the server environment (e.g.{" "}
        <code className="font-mono">.env.local</code>) and restart:
      </p>
      <pre className="overflow-x-auto bg-muted p-3 font-mono text-[0.7rem]">
        {`MCPOCKET_ADMIN_USERNAME=admin
MCPOCKET_ADMIN_PASSWORD=<strong password>
MCPOCKET_SESSION_SECRET=<openssl rand -base64 32>`}
      </pre>
    </div>
  )
}

/** Password login is switched off but no SSO is configured. */
function SsoMisconfiguredNotice() {
  return (
    <div className="flex flex-col gap-3 text-xs">
      <p className="font-medium">This dashboard uses single sign-on.</p>
      <p className="text-muted-foreground">
        Password sign-in is switched off (
        <code className="font-mono">MCPOCKET_PASSWORD_LOGIN=false</code>) but
        no single sign-on is configured. Set{" "}
        <code className="font-mono">MCPOCKET_SSO_SECRET</code> and{" "}
        <code className="font-mono">MCPOCKET_SSO_LOGIN_URL</code>, or enable
        password sign-in again, and restart.
      </p>
    </div>
  )
}

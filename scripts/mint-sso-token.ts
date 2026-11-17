/**
 * `npm run sso:token -- <email> [--ws <slug>] [--ttl <seconds>] [--next <path>] [--url <base>]`
 *
 * Mints a short-lived SSO login token (compact HS256 JWT) from
 * `MCPOCKET_SSO_SECRET` and prints a ready-to-open sign-in link, so the SSO
 * flow can be checked by hand without MCPocket Cloud. Reads the secret from
 * the environment, else from `.env.local` / `.env` in the working directory.
 *
 * - `--ws` defaults to `MCPOCKET_SSO_WORKSPACE`, else `MCPOCKET_WORKSPACE`
 *   (cloud mode needs a workspace in every token)
 * - `--ttl` defaults to 60 (the maximum the server accepts)
 * - `--url` defaults to `MCPOCKET_URL` or http://localhost:3000
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { parseArgs } from "node:util"

import {
  signSsoToken,
  SSO_MAX_TOKEN_LIFETIME_SECONDS,
} from "@mcpocket/core/auth/sso"

function loadEnvFiles() {
  for (const file of [".env.local", ".env"]) {
    // Never overrides variables that are already set.
    if (existsSync(file)) process.loadEnvFile(file)
  }
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ws: { type: "string" },
      ttl: { type: "string" },
      next: { type: "string" },
      url: { type: "string" },
    },
  })
  const email = positionals[0]
  if (!email) {
    throw new Error(
      "Usage: npm run sso:token -- <email> [--ws <slug>] [--ttl <seconds>] [--next <path>] [--url <base>]"
    )
  }
  loadEnvFiles()
  const secret = process.env.MCPOCKET_SSO_SECRET?.trim()
  if (!secret) {
    throw new Error(
      "MCPOCKET_SSO_SECRET is not set (environment, .env.local or .env)"
    )
  }
  const ttl = Number(values.ttl ?? SSO_MAX_TOKEN_LIFETIME_SECONDS)
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error("--ttl must be a positive whole number of seconds")
  }
  const ws =
    values.ws ??
    (process.env.MCPOCKET_SSO_WORKSPACE?.trim() ||
      process.env.MCPOCKET_WORKSPACE?.trim())
  const iat = Math.floor(Date.now() / 1000)
  const token = signSsoToken(secret, {
    sub: email,
    ...(ws ? { ws } : {}),
    jti: randomUUID(),
    iat,
    exp: iat + ttl,
  })
  const base = values.url ?? process.env.MCPOCKET_URL ?? "http://localhost:3000"
  const url = new URL("/auth/sso", base)
  url.searchParams.set("token", token)
  if (values.next) url.searchParams.set("next", values.next)

  console.log(token)
  console.error(`\nOpen within ${ttl} s (single use):\n${url.toString()}`)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

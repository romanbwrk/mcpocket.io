import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import { RoleSchema, type Role } from "../domain/access"

/**
 * API-key configuration and secret handling shared by authentication
 * (`lib/api/auth.ts`) and the key management service.
 *
 * Two sources of keys:
 * - Environment (`MCPOCKET_API_KEYS="keyId:secret,..."`), read-only. Their
 *   role comes from `MCPOCKET_API_KEY_ROLES="keyId:role,..."`, else
 *   `MCPOCKET_API_KEY_DEFAULT_ROLE` (default `admin`, so keys configured
 *   before RBAC keep full access). Env keys are never scoped.
 * - Managed keys created from the dashboard / REST, stored hashed in the
 *   `apiKeys` collection with role, scope, agent binding and rate limit.
 */

export type EnvApiKey = { id: string; secretHash: Buffer; role: Role }

/** SHA-256 of a secret (raw bytes). */
export const hashSecret = (secret: string): Buffer =>
  createHash("sha256").update(secret).digest()

export const hashSecretHex = (secret: string): string =>
  hashSecret(secret).toString("hex")

/** Constant-time comparison of two SHA-256 digests. */
export const sameHash = (a: Buffer, b: Buffer): boolean =>
  a.length === b.length && timingSafeEqual(a, b)

export const SECRET_PREFIX = "mcp_"

/** New random secret (`mcp_` + 32 bytes base64url) and the prefix shown in lists. */
export function generateSecret(): { secret: string; prefix: string } {
  const secret = `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`
  return { secret, prefix: secret.slice(0, SECRET_PREFIX.length + 4) }
}

type Env = Record<string, string | undefined>

const entries = (raw: string | undefined) =>
  (raw ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)

function parseRole(value: string, source: string): Role {
  const parsed = RoleSchema.safeParse(value.trim())
  if (!parsed.success) {
    throw new Error(
      `${source}: unknown role "${value.trim()}" (expected ${RoleSchema.options.join(", ")})`
    )
  }
  return parsed.data
}

/** `MCPOCKET_API_KEY_ROLES` → keyId → role. */
export function parseApiKeyRoles(raw: string | undefined): Map<string, Role> {
  const roles = new Map<string, Role>()
  for (const [index, entry] of entries(raw).entries()) {
    const sep = entry.indexOf(":")
    const id = sep > 0 ? entry.slice(0, sep).trim() : ""
    if (!id) {
      throw new Error(
        `MCPOCKET_API_KEY_ROLES: entry #${index + 1} is not of the form keyId:role`
      )
    }
    roles.set(id, parseRole(entry.slice(sep + 1), "MCPOCKET_API_KEY_ROLES"))
  }
  return roles
}

/**
 * `MCPOCKET_API_KEYS` (+ roles) → env keys. Errors never include a secret
 * (only the entry position).
 */
export function parseApiKeys(
  raw: string | undefined,
  options: { roles?: Map<string, Role>; defaultRole?: Role } = {}
): EnvApiKey[] {
  const { roles = new Map(), defaultRole = "admin" } = options
  return entries(raw).map((entry, index) => {
    const sep = entry.indexOf(":")
    const id = sep > 0 ? entry.slice(0, sep).trim() : ""
    const secret = sep > 0 ? entry.slice(sep + 1).trim() : ""
    if (!id || !secret) {
      throw new Error(
        `MCPOCKET_API_KEYS: entry #${index + 1} is not of the form keyId:secret`
      )
    }
    return {
      id,
      secretHash: hashSecret(secret),
      role: roles.get(id) ?? defaultRole,
    }
  })
}

let cache: { signature: string; keys: EnvApiKey[] } | undefined

/** Env keys, re-parsed only when one of the variables changes. */
export function apiKeysFromEnv(env: Env = process.env): EnvApiKey[] {
  const raw = env.MCPOCKET_API_KEYS
  const rawRoles = env.MCPOCKET_API_KEY_ROLES
  const rawDefault = env.MCPOCKET_API_KEY_DEFAULT_ROLE?.trim()
  const signature = JSON.stringify([raw, rawRoles, rawDefault])
  if (!cache || cache.signature !== signature) {
    const keys = parseApiKeys(raw, {
      roles: parseApiKeyRoles(rawRoles),
      defaultRole: rawDefault
        ? parseRole(rawDefault, "MCPOCKET_API_KEY_DEFAULT_ROLE")
        : "admin",
    })
    cache = { signature, keys }
  }
  return cache.keys
}

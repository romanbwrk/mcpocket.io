import { createHash, createHmac, timingSafeEqual } from "node:crypto"

import { uploadSigningKey } from "./upload-token"

/**
 * Access to media served by this server (`GET /api/media/files/{key}`).
 *
 * - `private` (default): a file is served only to an API key with `read`,
 *   a signed-in dashboard session, or a signed link from
 *   `create_media_link` (`?exp=<epoch s>&sig=<hmac>`, expiring).
 * - `public`: anyone with the link (keys are unguessable content hashes).
 *
 * Items always store the permanent, unsigned URL; signed links are minted
 * on demand for outside consumers (generators, social networks, players).
 */
export const MEDIA_ACCESS_MODES = ["private", "public"] as const
export type MediaAccess = (typeof MEDIA_ACCESS_MODES)[number]

export const DEFAULT_MEDIA_LINK_TTL_SECONDS = 60 * 60
export const MAX_MEDIA_LINK_TTL_SECONDS = 7 * 24 * 60 * 60

/** `MCPOCKET_MEDIA_ACCESS` (private|public), default private. */
export function mediaAccessFromEnv(
  env: Record<string, string | undefined> = process.env
): MediaAccess {
  const raw = (env.MCPOCKET_MEDIA_ACCESS?.trim() || "private").toLowerCase()
  if (!MEDIA_ACCESS_MODES.includes(raw as MediaAccess)) {
    throw new Error(`Invalid MCPOCKET_MEDIA_ACCESS "${raw}" (private|public)`)
  }
  return raw as MediaAccess
}

/** HMAC key for media links, derived from the upload signing key. */
function linkKey(): Buffer {
  return createHash("sha256")
    .update(
      Buffer.concat([Buffer.from("mcpocket-media-link:"), uploadSigningKey()])
    )
    .digest()
}

const mac = (key: string, exp: number) =>
  createHmac("sha256", linkKey()).update(`${key}\n${exp}`).digest("base64url")

/** `url` (the object's permanent URL) with `exp` / `sig` appended. */
export function signMediaUrl(url: string, key: string, exp: number): string {
  const u = new URL(url)
  u.searchParams.set("exp", String(exp))
  u.searchParams.set("sig", mac(key, exp))
  return u.toString()
}

/** True when `sig` signs `key` until `exp` and `exp` is in the future. */
export function verifyMediaSignature(
  key: string,
  exp: string | null,
  sig: string | null,
  nowSeconds: number
): boolean {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp)) return false
  const expires = Number(exp)
  if (expires < nowSeconds) return false
  const given = Buffer.from(sig, "base64url")
  const expected = Buffer.from(mac(key, expires), "base64url")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

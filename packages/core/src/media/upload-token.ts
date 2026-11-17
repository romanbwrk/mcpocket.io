import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { adminConfigFromEnv } from "../auth/session"
import { UnauthorizedError } from "../domain/errors"
import { storageConfigFromEnv } from "../storage"

/**
 * Signed upload links (`create_media_upload` → `PUT /api/media/uploads/{token}`).
 * An agent with a shell but no way to put bytes into a tool call (a local
 * render, a downloaded video) gets a short-lived URL it can `curl` the file
 * to, without handing its API key to the shell.
 *
 * Signing key: see `uploadSigningKey`.
 *
 * Token = base64url(JSON claims) "." base64url(HMAC-SHA256). The claims name
 * the API key that asked for the link; the upload re-checks that key (not
 * revoked, may push), so revoking a key also kills its open links.
 */
export type UploadClaims = {
  /** API key id that created the link. */
  k: string
  /** Expiry, epoch seconds. */
  e: number
  /** Content type the upload must declare (optional lock). */
  t?: string
  /** Filename stored with the object. */
  n?: string
  /** Workspace the link uploads into (multi-workspace mode). */
  w?: string
}

export const DEFAULT_UPLOAD_TTL_SECONDS = 15 * 60
export const MAX_UPLOAD_TTL_SECONDS = 60 * 60

const GLOBAL_KEY = Symbol.for("mcpocket.uploadSigningKey")
type Slot = { [GLOBAL_KEY]?: Buffer }

/** Persisted random key in the data directory (no secret configured). */
export const UPLOAD_SECRET_FILE = ".media-upload-secret"

const derive = (material: Buffer) =>
  createHash("sha256")
    .update(Buffer.concat([Buffer.from("mcpocket-media-upload:"), material]))
    .digest()

/**
 * Random key kept in `<DATA_DIR>/.media-upload-secret` (created once, mode
 * 0600), so links survive restarts and are shared by every process using
 * the same data directory. `null` when the directory is not writable.
 */
function persistedKey(dataDir: string): Buffer | null {
  const file = path.join(
    /* turbopackIgnore: true */ dataDir,
    UPLOAD_SECRET_FILE
  )
  const read = () => {
    const hex = readFileSync(file, "utf8").trim()
    return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null
  }
  try {
    return read()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null
  }
  try {
    mkdirSync(dataDir, { recursive: true })
    // `wx`: another process may create it at the same time — then read theirs.
    writeFileSync(file, randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o600,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null
  }
  try {
    return read()
  } catch {
    return null
  }
}

/**
 * HMAC key for upload links, first match wins:
 * 1. the session secret (`MCPOCKET_SESSION_SECRET`, or the one derived from
 *    the admin password / SSO secret) — works across instances;
 * 2. a random key persisted in the data directory — survives restarts;
 * 3. a per-process random key (read-only data directory).
 */
export function uploadSigningKey(
  env: Record<string, string | undefined> = process.env
): Buffer {
  const slot = globalThis as Slot
  const cached = slot[GLOBAL_KEY]
  if (cached) return cached
  const { secret } = adminConfigFromEnv(env)
  const key = secret
    ? derive(secret)
    : derive(persistedKey(storageConfigFromEnv(env).dataDir) ?? randomBytes(32))
  slot[GLOBAL_KEY] = key
  return key
}

/** Tests: forget the cached key. */
export function resetUploadSigningKey() {
  delete (globalThis as Slot)[GLOBAL_KEY]
}

const sign = (key: Buffer, body: string) =>
  createHmac("sha256", key).update(body).digest("base64url")

export function createUploadToken(claims: UploadClaims, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${body}.${sign(key, body)}`
}

/** Claims of a valid, unexpired token; 401 otherwise. */
export function verifyUploadToken(
  token: string,
  key: Buffer,
  nowSeconds: number
): UploadClaims {
  const invalid = () => new UnauthorizedError("Invalid or expired upload link")
  const dot = token.indexOf(".")
  if (dot <= 0 || token.length > 4096) throw invalid()
  const body = token.slice(0, dot)
  const mac = Buffer.from(token.slice(dot + 1), "base64url")
  const expected = Buffer.from(sign(key, body), "base64url")
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw invalid()
  }
  let claims: UploadClaims
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
  } catch {
    throw invalid()
  }
  if (
    typeof claims?.k !== "string" ||
    typeof claims.e !== "number" ||
    claims.e < nowSeconds
  ) {
    throw invalid()
  }
  return claims
}

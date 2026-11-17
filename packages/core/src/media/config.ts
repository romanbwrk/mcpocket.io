import { multiWorkspaceEnabled, workspaceFromEnv } from "../workspace"

/**
 * Media module configuration (S3 or any S3-compatible store: MinIO,
 * Cloudflare R2, Backblaze B2, DigitalOcean Spaces, ...). Media is enabled
 * when `MCPOCKET_S3_BUCKET` is set; otherwise data URIs inside items are
 * stored unchanged and `POST /api/media` answers 409.
 */
export type MediaConfig = {
  bucket: string
  region: string
  /** Custom endpoint for S3-compatible stores; unset = AWS. */
  endpoint?: string
  forcePathStyle: boolean
  /** Unset = the SDK's default credential chain (AWS_* env, profile, IAM role). */
  accessKeyId?: string
  secretAccessKey?: string
  /** Canned ACL sent with every upload (e.g. `public-read`); unset = none. */
  acl?: string
  /**
   * Base URL objects are served from (CDN / public bucket domain). When set
   * it wins over `delivery`.
   */
  publicUrl?: string
  /**
   * How links reach the bytes without a `publicUrl`: `server` (default) —
   * through this server's `GET /api/media/files/{key}`, so the bucket can
   * stay private; `bucket` — straight from the bucket URL (must be public).
   */
  delivery: MediaDelivery
  /**
   * This server's public origin (`MCPOCKET_PUBLIC_URL`) for `server`
   * delivery links; unset = the origin of the request that stored the file.
   */
  serverUrl?: string
  /**
   * Object key prefix, e.g. `media/`, plus `<workspace>/` when the instance
   * has a workspace (`MCPOCKET_WORKSPACE` / `MCPOCKET_SSO_WORKSPACE`), so
   * workspaces sharing a bucket never see each other's files.
   */
  prefix: string
  /** Max decoded size of one media object in bytes. */
  maxBytes: number
  /** MIME allowlist (`image/*` wildcards allowed); empty = any type. */
  allowedTypes: string[]
}

export const DEFAULT_MEDIA_MAX_BYTES = 50 * 1024 * 1024

export const MEDIA_DELIVERIES = ["server", "bucket"] as const
export type MediaDelivery = (typeof MEDIA_DELIVERIES)[number]

type Env = Record<string, string | undefined>

const str = (env: Env, key: string) => env[key]?.trim() || undefined

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = str(env, key)?.toLowerCase()
  if (raw === undefined) return fallback
  if (["1", "true", "yes", "on"].includes(raw)) return true
  if (["0", "false", "no", "off"].includes(raw)) return false
  throw new Error(`Invalid ${key} "${raw}" (true|false)`)
}

const trimSlashes = (s: string) => s.replace(/\/+$/, "")

/** `null` when media is not configured (no `MCPOCKET_S3_BUCKET`). */
export function mediaConfigFromEnv(env: Env = process.env): MediaConfig | null {
  const bucket = str(env, "MCPOCKET_S3_BUCKET")
  if (!bucket) return null

  const rawMax = str(env, "MCPOCKET_MEDIA_MAX_BYTES")
  const maxBytes =
    rawMax === undefined ? DEFAULT_MEDIA_MAX_BYTES : Number(rawMax)
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error(
      `Invalid MCPOCKET_MEDIA_MAX_BYTES "${rawMax}" (integer ≥ 1)`
    )
  }

  const accessKeyId = str(env, "MCPOCKET_S3_ACCESS_KEY_ID")
  const secretAccessKey = str(env, "MCPOCKET_S3_SECRET_ACCESS_KEY")
  if (!accessKeyId !== !secretAccessKey) {
    throw new Error(
      "Set both MCPOCKET_S3_ACCESS_KEY_ID and MCPOCKET_S3_SECRET_ACCESS_KEY, or neither"
    )
  }

  const endpoint = str(env, "MCPOCKET_S3_ENDPOINT")
  const publicUrl = str(env, "MCPOCKET_MEDIA_PUBLIC_URL")
  const serverUrl = str(env, "MCPOCKET_PUBLIC_URL")
  for (const [key, value] of [
    ["MCPOCKET_S3_ENDPOINT", endpoint],
    ["MCPOCKET_MEDIA_PUBLIC_URL", publicUrl],
    ["MCPOCKET_PUBLIC_URL", serverUrl],
  ] as const) {
    if (value !== undefined && !/^https?:\/\/[^/]/i.test(value)) {
      throw new Error(`Invalid ${key} "${value}" (absolute http(s) URL)`)
    }
  }

  const delivery = (
    str(env, "MCPOCKET_MEDIA_DELIVERY") ?? "server"
  ).toLowerCase() as MediaDelivery
  if (!MEDIA_DELIVERIES.includes(delivery)) {
    throw new Error(
      `Invalid MCPOCKET_MEDIA_DELIVERY "${delivery}" (server|bucket)`
    )
  }

  let prefix = str(env, "MCPOCKET_MEDIA_PREFIX") ?? "media/"
  prefix = prefix.replace(/^\/+/, "")
  if (prefix && !prefix.endsWith("/")) prefix += "/"
  // Multi-workspace mode adds the workspace per request instead
  // (`mediaStoreForWorkspace`).
  const workspace = multiWorkspaceEnabled(env) ? null : workspaceFromEnv(env)
  if (workspace) prefix += `${workspace}/`

  return {
    bucket,
    region: str(env, "MCPOCKET_S3_REGION") ?? "us-east-1",
    ...(endpoint && { endpoint: trimSlashes(endpoint) }),
    // Custom endpoints (MinIO, ...) usually need path-style addressing.
    forcePathStyle: bool(env, "MCPOCKET_S3_FORCE_PATH_STYLE", !!endpoint),
    ...(accessKeyId && { accessKeyId, secretAccessKey }),
    ...(str(env, "MCPOCKET_S3_ACL") && { acl: str(env, "MCPOCKET_S3_ACL") }),
    ...(publicUrl && { publicUrl: trimSlashes(publicUrl) }),
    delivery,
    ...(serverUrl && { serverUrl: trimSlashes(serverUrl) }),
    prefix,
    maxBytes,
    allowedTypes: (str(env, "MCPOCKET_MEDIA_ALLOWED_TYPES") ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  }
}

/** `image/png` against `["image/*", "application/pdf"]`; empty list = any. */
export function isAllowedType(contentType: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true
  const type = contentType.toLowerCase()
  return allowed.some((pattern) =>
    pattern.endsWith("/*")
      ? type.startsWith(pattern.slice(0, -1))
      : pattern === "*" || pattern === "*/*" || pattern === type
  )
}

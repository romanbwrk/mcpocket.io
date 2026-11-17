import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Webhook payload signing (ticket 17), Stripe-style:
 *
 *   X-MCPocket-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>
 *
 * The timestamp is part of the signed string, so receivers can reject
 * replays older than a tolerance. Receivers verify with the raw request body
 * (before JSON parsing) — see `verifyWebhookSignature`.
 */

export const SIGNATURE_HEADER = "x-mcpocket-signature"
export const WEBHOOK_SECRET_PREFIX = "whsec_"

/** A new random per-subscription secret (`whsec_` + 32 random bytes, base64url). */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`
}

export function computeSignature(
  secret: string,
  timestamp: number,
  body: string
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex")
}

/** Header value for `body` signed at `timestamp` (unix seconds). */
export function signWebhookPayload(
  secret: string,
  body: string,
  timestamp: number
): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, body)}`
}

export function parseSignatureHeader(
  header: string
): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2)
    if (key === "t" && value && /^\d+$/.test(value)) timestamp = Number(value)
    else if (key === "v1" && value) signatures.push(value)
  }
  return timestamp === null || signatures.length === 0
    ? null
    : { timestamp, signatures }
}

/**
 * Checks a signature header against the raw body: any `v1` matches
 * (constant-time) and the timestamp is within `toleranceSeconds` of `now`
 * (default 5 minutes; 0 disables the age check).
 */
export function verifyWebhookSignature(
  secret: string,
  header: string | null | undefined,
  body: string,
  {
    toleranceSeconds = 300,
    now = new Date(),
  }: { toleranceSeconds?: number; now?: Date } = {}
): boolean {
  if (!header) return false
  const parsed = parseSignatureHeader(header)
  if (!parsed) return false
  if (
    toleranceSeconds > 0 &&
    Math.abs(Math.floor(now.getTime() / 1000) - parsed.timestamp) >
      toleranceSeconds
  ) {
    return false
  }
  const expected = Buffer.from(
    computeSignature(secret, parsed.timestamp, body),
    "hex"
  )
  return parsed.signatures.some((sig) => {
    const given = Buffer.from(sig, "hex")
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}

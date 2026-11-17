/**
 * Agent availability (plan §8.4), derived from the age of the agent's latest
 * sign of life: its last heartbeat or any other audit event it wrote (claim,
 * complete, fail, …) — whichever is newer. Client-safe (no Node imports), so
 * the dashboard can re-evaluate it on a ticking clock.
 *
 * - online: active within `onlineSeconds`
 * - idle:   active within `staleSeconds`
 * - stale:  older, or never seen (e.g. only assigned by an admin)
 */

export const AGENT_AVAILABILITIES = ["online", "idle", "stale"] as const
export type AgentAvailability = (typeof AGENT_AVAILABILITIES)[number]

export type AvailabilityThresholds = {
  /** Max activity age (seconds) to count as online. */
  onlineSeconds: number
  /** Max activity age (seconds) to count as idle; older = stale. */
  staleSeconds: number
}

/** Defaults sized for the default 300 s lease (heartbeat well within it). */
export const DEFAULT_AVAILABILITY_THRESHOLDS: AvailabilityThresholds = {
  onlineSeconds: 120,
  staleSeconds: 600,
}

const MAX_THRESHOLD_SECONDS = 30 * 86_400

/** Newest of `lastHeartbeatAt` / `lastSeenAt` (ISO), or null. */
export function lastActivityAt(agent: {
  lastHeartbeatAt: string | null
  lastSeenAt: string | null
}): string | null {
  const { lastHeartbeatAt: hb, lastSeenAt: seen } = agent
  if (!hb) return seen
  if (!seen) return hb
  return hb > seen ? hb : seen
}

export function agentAvailability(
  lastActivity: string | null,
  nowMs: number,
  thresholds: AvailabilityThresholds = DEFAULT_AVAILABILITY_THRESHOLDS
): AgentAvailability {
  if (!lastActivity) return "stale"
  const at = Date.parse(lastActivity)
  if (Number.isNaN(at)) return "stale"
  // Clamp: a timestamp slightly in the future (clock skew) counts as "now".
  const ageSeconds = Math.max(0, nowMs - at) / 1000
  if (ageSeconds <= thresholds.onlineSeconds) return "online"
  if (ageSeconds <= thresholds.staleSeconds) return "idle"
  return "stale"
}

function readSeconds(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number
): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_THRESHOLD_SECONDS) {
    throw new Error(
      `Invalid ${name} "${raw}" (integer seconds 1..${MAX_THRESHOLD_SECONDS})`
    )
  }
  return n
}

/**
 * `MCPOCKET_AGENT_ONLINE_SECONDS` (default 120) and
 * `MCPOCKET_AGENT_STALE_SECONDS` (default 600; must be > online).
 */
export function availabilityThresholdsFromEnv(
  env: Record<string, string | undefined> = process.env
): AvailabilityThresholds {
  const onlineSeconds = readSeconds(
    env,
    "MCPOCKET_AGENT_ONLINE_SECONDS",
    DEFAULT_AVAILABILITY_THRESHOLDS.onlineSeconds
  )
  const staleSeconds = readSeconds(
    env,
    "MCPOCKET_AGENT_STALE_SECONDS",
    Math.max(DEFAULT_AVAILABILITY_THRESHOLDS.staleSeconds, onlineSeconds + 1)
  )
  if (staleSeconds <= onlineSeconds) {
    throw new Error(
      `MCPOCKET_AGENT_STALE_SECONDS (${staleSeconds}) must be greater than MCPOCKET_AGENT_ONLINE_SECONDS (${onlineSeconds})`
    )
  }
  return { onlineSeconds, staleSeconds }
}

/** `90` → "1m 30s", `7200` → "2h" — for threshold hints and ages. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s < 60) return `${s}s`
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`
}

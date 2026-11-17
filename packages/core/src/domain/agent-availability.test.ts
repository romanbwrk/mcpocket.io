import { describe, expect, it } from "vitest"

import {
  agentAvailability,
  availabilityThresholdsFromEnv,
  DEFAULT_AVAILABILITY_THRESHOLDS,
  formatDuration,
  lastActivityAt,
} from "./agent-availability"

const NOW = Date.parse("2026-11-15T12:00:00.000Z")
const ago = (s: number) => new Date(NOW - s * 1000).toISOString()

describe("agentAvailability", () => {
  const t = { onlineSeconds: 60, staleSeconds: 300 }

  it("classifies by activity age (inclusive bounds)", () => {
    expect(agentAvailability(ago(0), NOW, t)).toBe("online")
    expect(agentAvailability(ago(60), NOW, t)).toBe("online")
    expect(agentAvailability(ago(61), NOW, t)).toBe("idle")
    expect(agentAvailability(ago(300), NOW, t)).toBe("idle")
    expect(agentAvailability(ago(301), NOW, t)).toBe("stale")
  })

  it("never seen / unparsable is stale; future timestamps are online", () => {
    expect(agentAvailability(null, NOW, t)).toBe("stale")
    expect(agentAvailability("nope", NOW, t)).toBe("stale")
    expect(agentAvailability(ago(-30), NOW, t)).toBe("online")
  })

  it("uses defaults when thresholds are omitted", () => {
    expect(agentAvailability(ago(100), NOW)).toBe("online")
    expect(agentAvailability(ago(500), NOW)).toBe("idle")
    expect(agentAvailability(ago(700), NOW)).toBe("stale")
  })
})

describe("lastActivityAt", () => {
  it("returns the newer of heartbeat / last seen", () => {
    expect(lastActivityAt({ lastHeartbeatAt: null, lastSeenAt: null })).toBe(
      null
    )
    expect(lastActivityAt({ lastHeartbeatAt: ago(5), lastSeenAt: null })).toBe(
      ago(5)
    )
    expect(
      lastActivityAt({ lastHeartbeatAt: ago(50), lastSeenAt: ago(5) })
    ).toBe(ago(5))
    expect(
      lastActivityAt({ lastHeartbeatAt: ago(5), lastSeenAt: ago(50) })
    ).toBe(ago(5))
  })
})

describe("availabilityThresholdsFromEnv", () => {
  it("defaults", () => {
    expect(availabilityThresholdsFromEnv({})).toEqual(
      DEFAULT_AVAILABILITY_THRESHOLDS
    )
  })

  it("reads both env vars", () => {
    expect(
      availabilityThresholdsFromEnv({
        MCPOCKET_AGENT_ONLINE_SECONDS: "30",
        MCPOCKET_AGENT_STALE_SECONDS: " 90 ",
      })
    ).toEqual({ onlineSeconds: 30, staleSeconds: 90 })
  })

  it("raises the default stale bound above a large online threshold", () => {
    expect(
      availabilityThresholdsFromEnv({ MCPOCKET_AGENT_ONLINE_SECONDS: "900" })
    ).toEqual({ onlineSeconds: 900, staleSeconds: 901 })
  })

  it("rejects invalid values", () => {
    expect(() =>
      availabilityThresholdsFromEnv({ MCPOCKET_AGENT_ONLINE_SECONDS: "abc" })
    ).toThrow(/MCPOCKET_AGENT_ONLINE_SECONDS/)
    expect(() =>
      availabilityThresholdsFromEnv({ MCPOCKET_AGENT_STALE_SECONDS: "0" })
    ).toThrow(/MCPOCKET_AGENT_STALE_SECONDS/)
    expect(() =>
      availabilityThresholdsFromEnv({
        MCPOCKET_AGENT_ONLINE_SECONDS: "60",
        MCPOCKET_AGENT_STALE_SECONDS: "60",
      })
    ).toThrow(/must be greater/)
  })
})

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [45, "45s"],
    [60, "1m"],
    [90, "1m 30s"],
    [3600, "1h"],
    [3660, "1h 1m"],
    [86_400, "1d"],
    [90_000, "1d 1h"],
  ])("%i → %s", (s, out) => {
    expect(formatDuration(s)).toBe(out)
  })
})

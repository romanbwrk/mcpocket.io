import { describe, expect, it } from "vitest"

import {
  agentHref,
  agentItemHref,
  agentItemsInput,
  agentTubeHref,
  decodeAgentIdParam,
  parseAgentViewQuery,
} from "./agents"

const TUBE = "11111111-1111-4111-8111-111111111111"
const ITEM = "22222222-2222-4222-8222-222222222222"

describe("agent URLs", () => {
  it("builds detail hrefs (encoded id, defaults omitted)", () => {
    expect(agentHref("bot-1")).toBe("/dashboard/agents/bot-1")
    expect(agentHref("team:bot@x")).toBe("/dashboard/agents/team%3Abot%40x")
    expect(
      agentHref("bot-1", { status: ["processing", "failed"], page: 2 })
    ).toBe("/dashboard/agents/bot-1?status=processing%2Cfailed&page=2")
    expect(agentHref("bot-1", { status: [], page: 1 })).toBe(
      "/dashboard/agents/bot-1"
    )
  })

  it("decodes route params (already-decoded ids pass through)", () => {
    expect(decodeAgentIdParam("team%3Abot%40x")).toBe("team:bot@x")
    expect(decodeAgentIdParam("team:bot@x")).toBe("team:bot@x")
    expect(decodeAgentIdParam("%E0%A4%A")).toBe("%E0%A4%A")
  })

  it("parses view state leniently", () => {
    expect(parseAgentViewQuery({})).toEqual({ status: [], page: 1 })
    expect(
      parseAgentViewQuery({ status: ["failed,bogus", "pending"], page: "3" })
    ).toEqual({ status: ["pending", "failed"], page: 3 })
    expect(parseAgentViewQuery({ page: "0" }).page).toBe(1)
    expect(parseAgentViewQuery({ page: "-2" }).page).toBe(1)
    expect(parseAgentViewQuery({ page: "x" }).page).toBe(1)
  })

  it("maps view state to agentItems input", () => {
    expect(agentItemsInput({ status: [], page: 1 })).toEqual({
      offset: 0,
      limit: 25,
    })
    expect(agentItemsInput({ status: ["processing"], page: 3 })).toEqual({
      status: ["processing"],
      offset: 50,
      limit: 25,
    })
  })

  it("links into the tube view filtered by agent (and the inspector)", () => {
    expect(agentTubeHref(TUBE, "bot-1")).toBe(
      `/dashboard/tubes/${TUBE}?assignedAgent=bot-1`
    )
    expect(agentItemHref(TUBE, ITEM, "bot-1")).toBe(
      `/dashboard/tubes/${TUBE}?assignedAgent=bot-1&item=${ITEM}`
    )
  })
})

import { describe, expect, it } from "vitest"

import { mediaHref, parseMediaQuery } from "./media"

describe("media library query", () => {
  it("parses known values and drops the rest", () => {
    expect(
      parseMediaQuery({ kind: "video", usage: "unused", page: "3" })
    ).toEqual({ kind: "video", usage: "unused", page: 3 })
    expect(parseMediaQuery({ kind: "x", usage: "y", page: "-1" })).toEqual({
      kind: null,
      usage: null,
      page: 1,
    })
  })

  it("builds links; filter changes reset the page", () => {
    const q = { kind: "image" as const, usage: null, page: 4 }
    expect(mediaHref(q, { page: 5 })).toBe("/dashboard/media?kind=image&page=5")
    expect(mediaHref(q, { kind: null })).toBe("/dashboard/media")
    expect(mediaHref(q, { usage: "unused" })).toBe(
      "/dashboard/media?kind=image&usage=unused"
    )
  })
})

describe("media links inside a tube", () => {
  it("keeps the tube's Media tab path", () => {
    const q = { kind: null, usage: null, page: 1 }
    expect(mediaHref(q, { kind: "video" }, "/dashboard/tubes/t1/media")).toBe(
      "/dashboard/tubes/t1/media?kind=video"
    )
  })
})

import { describe, expect, it } from "vitest"

import { chunkImportItems, parseImportText } from "./item-import"

describe("parseImportText", () => {
  it("wraps raw objects of an array as payloads", () => {
    expect(parseImportText('[{"a":1},{"b":2}]')).toEqual({
      ok: true,
      items: [{ payload: { a: 1 } }, { payload: { b: 2 } }],
    })
  })

  it("keeps push envelopes as they are", () => {
    const envelope = { payload: { a: 1 }, priority: 5, tags: ["x"] }
    expect(parseImportText(JSON.stringify([envelope]))).toEqual({
      ok: true,
      items: [envelope],
    })
  })

  it("treats an object with extra keys next to payload as a raw payload", () => {
    const raw = { payload: { a: 1 }, other: true }
    expect(parseImportText(JSON.stringify([raw]))).toEqual({
      ok: true,
      items: [{ payload: raw }],
    })
  })

  it("accepts { items: [...] }, a single object and JSON Lines", () => {
    expect(parseImportText('{"items":[{"a":1}]}')).toEqual({
      ok: true,
      items: [{ payload: { a: 1 } }],
    })
    expect(parseImportText('{"a":1}')).toEqual({
      ok: true,
      items: [{ payload: { a: 1 } }],
    })
    expect(parseImportText('{"a":1}\n\n{"b":2}\n')).toEqual({
      ok: true,
      items: [{ payload: { a: 1 } }, { payload: { b: 2 } }],
    })
  })

  it("rejects empty text, invalid JSON, empty arrays and non-objects", () => {
    expect(parseImportText("  ")).toMatchObject({ ok: false })
    expect(parseImportText("[{")).toMatchObject({ ok: false })
    expect(parseImportText("[]")).toMatchObject({ ok: false })
    expect(parseImportText("[null]")).toEqual({
      ok: false,
      error: "Entry 1 is not a JSON object or value",
    })
    expect(parseImportText('[{"a":1}, [2]]')).toEqual({
      ok: false,
      error: "Entry 2 is not a JSON object or value",
    })
  })

  it("accepts a plain list separated by commas or new lines", () => {
    expect(parseImportText("a@x.com, b@x.com\nc@x.com\r\n\n , ")).toEqual({
      ok: true,
      items: [
        { payload: { value: "a@x.com" } },
        { payload: { value: "b@x.com" } },
        { payload: { value: "c@x.com" } },
      ],
    })
    expect(parseImportText("42")).toEqual({
      ok: true,
      items: [{ payload: { value: "42" } }],
    })
    expect(parseImportText(" , \n")).toMatchObject({ ok: false })
  })

  it("wraps plain values inside a JSON array", () => {
    expect(parseImportText('["a", 2, {"b":3}]')).toEqual({
      ok: true,
      items: [
        { payload: { value: "a" } },
        { payload: { value: 2 } },
        { payload: { b: 3 } },
      ],
    })
  })
})

describe("chunkImportItems", () => {
  it("splits by item count", () => {
    const chunks = chunkImportItems([1, 2, 3, 4, 5], 2)
    expect(chunks).toEqual([[1, 2], [3, 4], [5]])
  })

  it("splits by serialized size", () => {
    const items = ["aaaa", "bbbb", "cccc"] // 6 bytes + 1 each
    expect(chunkImportItems(items, 100, 14)).toEqual([
      ["aaaa", "bbbb"],
      ["cccc"],
    ])
  })

  it("puts an oversized item into its own chunk", () => {
    expect(chunkImportItems(["x".repeat(50), "y"], 100, 10)).toEqual([
      ["x".repeat(50)],
      ["y"],
    ])
  })
})

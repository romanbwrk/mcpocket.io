import { describe, expect, it } from "vitest"

import { historyDiff, previewJson } from "./history-diff"
import { lineColumn, tokenizeJson, validatePayloadText } from "./json-text"

describe("tokenizeJson", () => {
  it("classifies tokens and round-trips the text", () => {
    const text = '{\n  "a": "x",\n  "n": -1.5e3, "ok": true, "z": null, bad\n}'
    const tokens = tokenizeJson(text)
    expect(tokens.map((t) => t.text).join("")).toBe(text)
    const byText = Object.fromEntries(tokens.map((t) => [t.text, t.type]))
    expect(byText).toMatchObject({
      '"a"': "key",
      '"x"': "string",
      "-1.5e3": "number",
      true: "literal",
      null: "literal",
      bad: "invalid",
      "{": "punct",
    })
  })

  it("round-trips unterminated strings", () => {
    const text = '{"a": "unterminated\n}'
    expect(
      tokenizeJson(text)
        .map((t) => t.text)
        .join("")
    ).toBe(text)
  })
})

describe("validatePayloadText", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  }

  it("accepts objects that match the schema", () => {
    expect(validatePayloadText('{"name":"x"}', schema)).toEqual({
      ok: true,
      value: { name: "x" },
    })
    expect(validatePayloadText("{}")).toMatchObject({ ok: true })
  })

  it("reports parse errors with a position", () => {
    const result = validatePayloadText('{\n  "a": 1,\n}')
    expect(result).toMatchObject({ ok: false, kind: "parse" })
    if (result.ok) throw new Error("unreachable")
    expect(result.issues[0].line).toBe(3)
    const end = validatePayloadText('{"a": 1')
    if (end.ok) throw new Error("unreachable")
    expect(end.issues[0].line).toBe(1)
  })

  it("rejects non-objects and schema violations", () => {
    expect(validatePayloadText("[1]")).toMatchObject({
      ok: false,
      kind: "shape",
    })
    expect(validatePayloadText('{"name": 1}', schema)).toMatchObject({
      ok: false,
      kind: "schema",
      issues: [{ path: "/name", message: "must be string" }],
    })
  })

  it("lineColumn is 1-based", () => {
    expect(lineColumn("ab\ncd", 4)).toEqual({ line: 2, column: 2 })
  })
})

describe("historyDiff", () => {
  it("diffs objects per top-level key", () => {
    expect(
      historyDiff(
        { status: "pending", a: 1, gone: true },
        { status: "cancelled", a: 1, added: [1] }
      )
    ).toEqual([
      {
        field: "status",
        kind: "changed",
        oldValue: "pending",
        newValue: "cancelled",
      },
      { field: "gone", kind: "removed", oldValue: true },
      { field: "added", kind: "added", newValue: [1] },
    ])
    expect(historyDiff(undefined, { a: 1 })).toEqual([
      { field: "a", kind: "added", newValue: 1 },
    ])
  })

  it("compares non-objects as a whole", () => {
    expect(historyDiff("a", "b")).toEqual([
      { field: "", kind: "changed", oldValue: "a", newValue: "b" },
    ])
    expect(historyDiff(1, 1)).toEqual([])
  })

  it("previews JSON compactly", () => {
    expect(previewJson({ a: "x".repeat(200) }, 10)).toHaveLength(10)
    expect(previewJson(undefined)).toBe("—")
  })
})

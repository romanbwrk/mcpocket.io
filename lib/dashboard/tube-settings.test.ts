import { describe, expect, it } from "vitest"

import {
  parseLeaseSeconds,
  parseRetryPolicyFields,
  parseSchemaText,
  retryPolicyFields,
} from "./tube-settings"

describe("parseSchemaText", () => {
  it("empty text means no schema", () => {
    expect(parseSchemaText("  \n")).toEqual({ ok: true, value: null })
  })
  it("parses a JSON object", () => {
    expect(parseSchemaText('{"type":"object"}')).toEqual({
      ok: true,
      value: { type: "object" },
    })
  })
  it("rejects invalid JSON and non-objects", () => {
    expect(parseSchemaText("{type:")).toMatchObject({ ok: false })
    for (const text of ["[]", "null", "42", '"x"']) {
      expect(parseSchemaText(text)).toEqual({
        ok: false,
        error: "The schema must be a JSON object",
      })
    }
  })
})

describe("retry policy fields", () => {
  const empty = {
    maxAttempts: "",
    backoff: "",
    delaySeconds: "",
    maxDelaySeconds: "",
  }
  it("all empty means no overrides", () => {
    expect(parseRetryPolicyFields(empty)).toEqual({ ok: true, value: null })
    expect(retryPolicyFields(undefined)).toEqual(empty)
  })
  it("round-trips set fields only", () => {
    const policy = {
      maxAttempts: 5,
      backoff: "fixed" as const,
      delaySeconds: 0,
    }
    expect(parseRetryPolicyFields(retryPolicyFields(policy))).toEqual({
      ok: true,
      value: policy,
    })
  })
  it("reports out-of-range values per field", () => {
    expect(
      parseRetryPolicyFields({
        ...empty,
        maxAttempts: "0",
        delaySeconds: "1.5",
        backoff: "linear",
      })
    ).toEqual({
      ok: false,
      errors: {
        maxAttempts: expect.any(String),
        delaySeconds: expect.any(String),
        backoff: expect.any(String),
      },
    })
  })
})

describe("parseLeaseSeconds", () => {
  it("parses whole seconds within bounds; empty = default", () => {
    expect(parseLeaseSeconds("")).toEqual({ ok: true, value: null })
    expect(parseLeaseSeconds(" 900 ")).toEqual({ ok: true, value: 900 })
    expect(parseLeaseSeconds("0").ok).toBe(false)
    expect(parseLeaseSeconds("1.5").ok).toBe(false)
    expect(parseLeaseSeconds("86401").ok).toBe(false)
  })
})

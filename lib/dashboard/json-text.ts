import { validateJsonSchema } from "@mcpocket/core/domain/json-schema"

/**
 * Client-safe helpers of the item inspector's JSON editor: syntax tokens for
 * highlighting and live payload validation (parse errors + tube schema). The
 * server validates again on save (`services.items.update`).
 */

export type JsonTokenType =
  "key" | "string" | "number" | "literal" | "punct" | "space" | "invalid"

export type JsonToken = { type: JsonTokenType; text: string }

const TOKEN_RE =
  /("(?:\\.|[^"\\\n])*"?)(?=(\s*:)?)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)\b|([{}[\],:])|(\s+)|([^\s"{}[\],:]+)/g

/** Splits JSON-ish text into highlight tokens; concatenated texts === input. */
export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = []
  for (const m of text.matchAll(TOKEN_RE)) {
    const [whole, str, colon, num, literal, punct, space] = m
    const type: JsonTokenType =
      str !== undefined
        ? colon
          ? "key"
          : "string"
        : num !== undefined
          ? "number"
          : literal !== undefined
            ? "literal"
            : punct !== undefined
              ? "punct"
              : space !== undefined
                ? "space"
                : "invalid"
    tokens.push({ type, text: whole })
  }
  return tokens
}

export type JsonTextIssue = {
  /** JSON Pointer into the payload (`/customer/name`), "" = root. */
  path?: string
  message: string
  /** 1-based position of a parse error, when known. */
  line?: number
  column?: number
}

export type PayloadTextResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; kind: "parse" | "shape" | "schema"; issues: JsonTextIssue[] }

/** 1-based line/column of a character offset. */
export function lineColumn(
  text: string,
  offset: number
): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)))
  const lines = before.split("\n")
  return { line: lines.length, column: lines[lines.length - 1].length + 1 }
}

function parseErrorIssue(text: string, error: unknown): JsonTextIssue {
  const raw = error instanceof Error ? error.message : "Invalid JSON"
  const lc = /\(line (\d+) column (\d+)\)/.exec(raw)
  const pos = /at position (\d+)/.exec(raw)
  const message = raw
    .replace(/\s*\(line \d+ column \d+\)/, "")
    .replace(/\s+in JSON at position \d+/, "")
  if (lc) return { message, line: Number(lc[1]), column: Number(lc[2]) }
  if (pos) return { message, ...lineColumn(text, Number(pos[1])) }
  if (/end of (JSON|data) input/i.test(raw)) {
    return { message, ...lineColumn(text, text.length) }
  }
  return { message }
}

/**
 * Editor text → payload object, or the reasons it would be rejected: invalid
 * JSON (with line/column), not an object, or `schema` violations (same Ajv
 * rules as the server).
 */
export function validatePayloadText(
  text: string,
  schema?: Record<string, unknown> | null
): PayloadTextResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { ok: false, kind: "parse", issues: [parseErrorIssue(text, error)] }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      kind: "shape",
      issues: [{ path: "", message: "The payload must be a JSON object" }],
    }
  }
  if (schema) {
    const issues = validateJsonSchema(schema, value)
    if (issues.length > 0) {
      return {
        ok: false,
        kind: "schema",
        issues: issues.map((i) => ({ path: i.path, message: i.message })),
      }
    }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

/** Pretty JSON for editors and read-only views (`undefined` → ""). */
export function formatJson(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2)
}

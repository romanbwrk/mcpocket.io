/**
 * Client-safe old → new diff of an audit event (item inspector timeline).
 * Object values are compared per top-level key; anything else as a whole.
 */

export type HistoryDiffRow = {
  /** Top-level field, or "" when the values are not objects. */
  field: string
  kind: "added" | "removed" | "changed"
  oldValue?: unknown
  newValue?: unknown
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function historyDiff(
  oldValue: unknown,
  newValue: unknown
): HistoryDiffRow[] {
  const oldObj = oldValue === undefined || isPlainObject(oldValue)
  const newObj = newValue === undefined || isPlainObject(newValue)
  if (!(oldObj && newObj)) {
    if (sameJson(oldValue, newValue)) return []
    return [
      {
        field: "",
        kind:
          oldValue === undefined
            ? "added"
            : newValue === undefined
              ? "removed"
              : "changed",
        oldValue,
        newValue,
      },
    ]
  }
  const before = (oldValue ?? {}) as Record<string, unknown>
  const after = (newValue ?? {}) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const rows: HistoryDiffRow[] = []
  for (const field of keys) {
    const inOld = field in before
    const inNew = field in after
    if (inOld && inNew && sameJson(before[field], after[field])) continue
    rows.push({
      field,
      kind: !inOld ? "added" : !inNew ? "removed" : "changed",
      ...(inOld && { oldValue: before[field] }),
      ...(inNew && { newValue: after[field] }),
    })
  }
  return rows
}

/** One-line JSON preview, truncated to `max` characters. */
export function previewJson(value: unknown, max = 120): string {
  if (value === undefined) return "—"
  const text = JSON.stringify(value) ?? String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

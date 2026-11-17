import { describe, expect, it } from "vitest"

import {
  getPath,
  ItemFilterSchema,
  itemQueryFromSearchParams,
  matchesCondition,
  matchesItemFilter,
  PayloadConditionSchema,
} from "./item-filter"
import type { Item } from "./schemas"

const payload = {
  name: "Alice",
  age: 42,
  zip: "01234",
  vip: true,
  note: null,
  customer: { address: { city: "Berlin" } },
  lines: [{ sku: "A-1" }, { sku: "B-2" }],
  labels: ["urgent", "eu"],
}

const cond = (c: unknown) => PayloadConditionSchema.parse(c)
const m = (c: unknown) => matchesCondition(payload, cond(c))

describe("payload conditions", () => {
  it("resolves dotted paths incl. array indices", () => {
    expect(getPath(payload, "customer.address.city")).toBe("Berlin")
    expect(getPath(payload, "lines.1.sku")).toBe("B-2")
    expect(getPath(payload, "lines.x")).toBeUndefined()
    expect(getPath(payload, "customer.missing.deep")).toBeUndefined()
    expect(getPath(payload, "name.length")).toBeUndefined()
  })

  it("eq (default op) is deep and loose for scalars", () => {
    expect(m({ path: "customer.address.city", value: "Berlin" })).toBe(true)
    expect(m({ path: "customer.address.city", value: "berlin" })).toBe(false)
    expect(m({ path: "age", value: 42 })).toBe(true)
    expect(m({ path: "age", value: "42" })).toBe(true)
    expect(m({ path: "vip", value: "true" })).toBe(true)
    expect(m({ path: "note", value: null })).toBe(true)
    expect(m({ path: "labels", value: ["urgent", "eu"] })).toBe(true)
    expect(m({ path: "missing", value: "undefined" })).toBe(false)
  })

  it("ne, in, exists, contains", () => {
    expect(m({ path: "age", op: "ne", value: 1 })).toBe(true)
    expect(m({ path: "missing", op: "ne", value: 1 })).toBe(true)
    expect(m({ path: "name", op: "in", value: ["Bob", "Alice"] })).toBe(true)
    expect(m({ path: "name", op: "in", value: ["Bob"] })).toBe(false)
    expect(m({ path: "note", op: "exists" })).toBe(true)
    expect(m({ path: "missing", op: "exists" })).toBe(false)
    expect(m({ path: "missing", op: "exists", value: false })).toBe(true)
    expect(m({ path: "name", op: "contains", value: "LIC" })).toBe(true)
    expect(m({ path: "labels", op: "contains", value: "eu" })).toBe(true)
    expect(m({ path: "age", op: "contains", value: 4 })).toBe(false)
  })

  it("range operators compare numbers numerically and strings lexically", () => {
    expect(m({ path: "age", op: "gt", value: 41 })).toBe(true)
    expect(m({ path: "age", op: "gte", value: "42" })).toBe(true)
    expect(m({ path: "age", op: "lt", value: 42 })).toBe(false)
    expect(m({ path: "age", op: "lte", value: 100 })).toBe(true)
    expect(m({ path: "age", op: "gt", value: "abc" })).toBe(false)
    expect(m({ path: "name", op: "gte", value: "Al" })).toBe(true)
    expect(m({ path: "missing", op: "lt", value: 1 })).toBe(false)
  })

  it("validates conditions", () => {
    expect(() => cond({ path: "a", op: "in", value: 1 })).toThrow()
    expect(() => cond({ path: "a", op: "exists", value: "yes" })).toThrow()
    expect(() => cond({ path: "a" })).toThrow()
    expect(() => cond({ path: "a..b", value: 1 })).toThrow()
    expect(() => cond({ path: "a", op: "regex", value: 1 })).toThrow()
  })
})

const item = (over: Partial<Item> = {}): Item => ({
  id: crypto.randomUUID(),
  tubeId: crypto.randomUUID(),
  status: "pending",
  payload,
  metadata: {},
  tags: ["a", "b"],
  priority: 5,
  assignedAgent: "bot-1",
  attempts: 0,
  createdAt: "2026-03-10T12:00:00.000Z",
  updatedAt: "2026-03-10T12:00:00.000Z",
  ...over,
})
const f = (input: unknown) => ItemFilterSchema.parse(input)

describe("matchesItemFilter", () => {
  it("combines every filter with AND", () => {
    const it1 = item()
    expect(matchesItemFilter(it1, f({}))).toBe(true)
    expect(matchesItemFilter(it1, f({ status: "pending,retry" }))).toBe(true)
    expect(matchesItemFilter(it1, f({ status: ["failed"] }))).toBe(false)
    expect(matchesItemFilter(it1, f({ assignedAgent: "bot-2" }))).toBe(false)
    expect(matchesItemFilter(it1, f({ priority: "5" }))).toBe(true)
    expect(matchesItemFilter(it1, f({ priorityMin: 6 }))).toBe(false)
    expect(matchesItemFilter(it1, f({ priorityMax: 5 }))).toBe(true)
    expect(matchesItemFilter(it1, f({ tags: "a,b" }))).toBe(true)
    expect(matchesItemFilter(it1, f({ tags: ["a", "c"] }))).toBe(false)
    expect(
      matchesItemFilter(
        it1,
        f({
          status: "pending",
          tags: "a",
          payload: [{ path: "age", op: "gte", value: 18 }],
        })
      )
    ).toBe(true)
  })

  it("date bounds are inclusive; date-only bounds cover the whole UTC day", () => {
    const it1 = item()
    expect(matchesItemFilter(it1, f({ createdFrom: "2026-03-10" }))).toBe(true)
    expect(matchesItemFilter(it1, f({ createdTo: "2026-03-10" }))).toBe(true)
    expect(matchesItemFilter(it1, f({ createdTo: "2026-03-09" }))).toBe(false)
    expect(
      matchesItemFilter(it1, f({ createdFrom: "2026-03-10T12:00:00.000Z" }))
    ).toBe(true)
    expect(
      matchesItemFilter(it1, f({ createdFrom: "2026-03-10T12:00:00.001Z" }))
    ).toBe(false)
    expect(() => f({ createdFrom: "yesterday" })).toThrow()
  })

  it("rejects invalid status values", () => {
    expect(() => f({ status: "pending,nope" })).toThrow()
  })
})

describe("itemQueryFromSearchParams", () => {
  it("maps payload.* keys to conditions and passes others through", () => {
    expect(
      itemQueryFromSearchParams({
        status: "pending",
        limit: "5",
        "payload.customer.city": "Berlin",
        "payload.age[gte]": "18",
        "payload.kind[in]": "a,b,3",
        "payload.note[exists]": "false",
        "payload.zip": "01234",
      })
    ).toEqual({
      status: "pending",
      limit: "5",
      payload: [
        { path: "customer.city", op: "eq", value: "Berlin" },
        { path: "age", op: "gte", value: 18 },
        { path: "kind", op: "in", value: ["a", "b", 3] },
        { path: "note", op: "exists", value: false },
        { path: "zip", op: "eq", value: "01234" },
      ],
    })
  })

  it("repeated keys add one condition each", () => {
    expect(
      itemQueryFromSearchParams({ "payload.age[gte]": ["1", "2"] }).payload
    ).toHaveLength(2)
  })
})

import { describe, expect, it } from "vitest"

import { ListItemsInputSchema } from "@mcpocket/core/services/items"

import { tubeItemsListInput } from "./tube-items"
import {
  activeFilterCount,
  EMPTY_TUBE_VIEW_QUERY,
  parseTubeViewQuery,
  tubeViewHref,
  tubeViewSearch,
  type TubeViewQuery,
} from "./tube-query"

const q = (patch: Partial<TubeViewQuery> = {}): TubeViewQuery => ({
  ...EMPTY_TUBE_VIEW_QUERY,
  ...patch,
})

describe("parseTubeViewQuery", () => {
  it("defaults for an empty URL", () => {
    expect(parseTubeViewQuery({})).toEqual(EMPTY_TUBE_VIEW_QUERY)
  })

  it("parses every filter from a Next searchParams record", () => {
    const query = parseTubeViewQuery({
      status: "failed,pending",
      assignedAgent: " bot-1 ",
      createdFrom: "2026-01-01",
      createdTo: "2026-02-01T10:00:00Z",
      priority: "3",
      priorityMin: "-1",
      priorityMax: "9",
      tags: ["vip", "eu,vip"],
      "payload.customer.city": "Berlin",
      "payload.amount[gte]": ["100", "50"],
      "payload.flag[exists]": "",
      page: "3",
      limit: "50",
    })
    expect(query).toEqual({
      // canonical status order, deduped tags
      status: ["pending", "failed"],
      assignedAgent: "bot-1",
      createdFrom: "2026-01-01",
      createdTo: "2026-02-01T10:00:00Z",
      priority: 3,
      priorityMin: -1,
      priorityMax: 9,
      tags: ["vip", "eu"],
      payload: [
        { path: "customer.city", op: "eq", value: "Berlin" },
        { path: "amount", op: "gte", value: "100" },
        { path: "amount", op: "gte", value: "50" },
        { path: "flag", op: "exists", value: "" },
      ],
      page: 3,
      limit: 50,
    })
  })

  it("drops malformed values instead of failing", () => {
    const query = parseTubeViewQuery(
      new URLSearchParams(
        "status=bogus,completed&createdFrom=yesterday&priority=1.5&page=-2&limit=7" +
          "&payload.a..b=1&payload.x[like]=1&payload.y="
      )
    )
    expect(query).toEqual(q({ status: ["completed"] }))
  })
})

describe("tubeViewSearch / tubeViewHref", () => {
  it("round-trips through the URL", () => {
    const query = q({
      status: ["retry", "failed"],
      assignedAgent: "agent a",
      tags: ["x"],
      priorityMin: 0,
      payload: [
        { path: "a.b", op: "eq", value: "1" },
        { path: "list", op: "in", value: "x,y" },
      ],
      page: 2,
      limit: 100,
    })
    const search = tubeViewSearch(query)
    expect(search).toBe(
      "status=retry%2Cfailed&assignedAgent=agent+a&priorityMin=0&tags=x" +
        "&payload.a.b=1&payload.list%5Bin%5D=x%2Cy&page=2&limit=100"
    )
    expect(parseTubeViewQuery(new URLSearchParams(search))).toEqual({
      ...query,
      status: ["failed", "retry"],
    })
  })

  it("omits defaults and resets the page when a filter changes", () => {
    const base = q({ page: 4 })
    expect(tubeViewHref("/t", q())).toBe("/t")
    expect(tubeViewHref("/t", base, { page: 5 })).toBe("/t?page=5")
    expect(tubeViewHref("/t", base, { status: ["pending"] })).toBe(
      "/t?status=pending"
    )
    expect(tubeViewHref("/t", base, { limit: 50 })).toBe("/t?limit=50")
  })

  it("counts active filters", () => {
    expect(activeFilterCount(q({ page: 3 }))).toBe(0)
    expect(
      activeFilterCount(
        q({
          status: ["pending", "failed"],
          tags: ["a"],
          payload: [
            { path: "a", op: "eq", value: "1" },
            { path: "b", op: "eq", value: "2" },
          ],
        })
      )
    ).toBe(4)
  })
})

describe("tubeItemsListInput", () => {
  it("produces valid items.list input in the REST filter format", () => {
    const input = tubeItemsListInput(
      parseTubeViewQuery(
        new URLSearchParams(
          "status=pending,failed&tags=a,b&priorityMax=5&createdFrom=2026-01-01" +
            "&payload.n[gt]=10&payload.kind[in]=a,1&payload.opt[exists]=false" +
            "&payload.name=Bob&page=3&limit=50"
        )
      )
    )
    expect(ListItemsInputSchema.parse(input)).toMatchObject({
      offset: 100,
      limit: 50,
      status: ["pending", "failed"],
      tags: ["a", "b"],
      priorityMax: 5,
      createdFrom: "2026-01-01",
      payload: [
        { path: "n", op: "gt", value: 10 },
        { path: "kind", op: "in", value: ["a", 1] },
        { path: "opt", op: "exists", value: false },
        { path: "name", op: "eq", value: "Bob" },
      ],
    })
  })
})

describe("inspector item param", () => {
  const id = "0b5f3c1e-2a4d-4e6f-8a9b-1c2d3e4f5a6b"

  it("parses a valid id and drops garbage", () => {
    expect(parseTubeViewQuery({ item: id }).item).toBe(id)
    expect(parseTubeViewQuery({ item: "nope" }).item).toBeUndefined()
  })

  it("opens/closes without touching page or filters", () => {
    const query = q({ status: ["failed"], page: 3 })
    const open = tubeViewHref("/t", query, { item: id })
    expect(open).toBe(`/t?status=failed&page=3&item=${id}`)
    const opened = parseTubeViewQuery(new URLSearchParams(open.split("?")[1]))
    expect(tubeViewHref("/t", opened, { item: undefined })).toBe(
      "/t?status=failed&page=3"
    )
    // filter change keeps the inspector open, resets the page
    expect(tubeViewHref("/t", opened, { tags: ["x"] })).toBe(
      `/t?status=failed&tags=x&item=${id}`
    )
    expect(tubeViewSearch(opened, { withItem: false })).toBe(
      "status=failed&page=3"
    )
  })
})

import { describe, expect, it } from "vitest"

import {
  parseWebhooksQuery,
  webhookFormInput,
  webhookScopeValue,
  webhooksHref,
} from "./webhooks"

const ID = "0b6a3c1e-2f4d-4a5b-8c9d-0e1f2a3b4c5d"

describe("webhooks dashboard helpers", () => {
  it("parses and builds the delivery log URL", () => {
    const q = parseWebhooksQuery({ webhook: ID, status: "dead" })
    expect(q).toEqual({ webhook: ID, status: "dead" })
    expect(parseWebhooksQuery({ webhook: "x", status: "nope" })).toEqual({
      webhook: null,
      status: null,
    })
    expect(webhooksHref(q)).toBe(
      `/dashboard/webhooks?webhook=${ID}&status=dead`
    )
    expect(webhooksHref(q, { status: null, webhook: null })).toBe(
      "/dashboard/webhooks"
    )
  })

  it("turns form fields into service input", () => {
    expect(
      webhookFormInput({
        name: " CRM ",
        url: " https://x.test/h ",
        eventTypes: [
          "item.deleted",
          "item.created",
          "item.updated",
          "item.status_changed",
        ],
        scope: `tube:${ID}`,
        enabled: true,
      })
    ).toEqual({
      name: "CRM",
      url: "https://x.test/h",
      eventTypes: [],
      folderId: null,
      tubeId: ID,
      enabled: true,
    })
    expect(
      webhookFormInput({
        name: "a",
        url: "u",
        eventTypes: ["item.deleted", "item.created"],
        scope: "",
        enabled: false,
      })
    ).toMatchObject({
      eventTypes: ["item.created", "item.deleted"],
      folderId: null,
      tubeId: null,
    })
    expect(webhookScopeValue({ folderId: ID, tubeId: null })).toBe(
      `folder:${ID}`
    )
  })
})

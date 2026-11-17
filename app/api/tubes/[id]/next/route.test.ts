import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetStorageSingleton } from "@mcpocket/core/storage"

import * as foldersRoute from "../../../folders/route"
import * as itemRoute from "../../../items/[id]/route"
import * as tubeItemsRoute from "../items/route"
import * as tubesRoute from "../../route"
import * as nextRoute from "./route"

const SECRET = "test-secret-123"
let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-next-route-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_API_KEYS", `ci:${SECRET}`)
  await resetStorageSingleton()
})
afterEach(async () => {
  await resetStorageSingleton()
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

const auth = { authorization: `Bearer ${SECRET}` }
const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { ...auth, "content-type": "application/json" },
  })
const params = <P>(p: P) => ({ params: Promise.resolve(p) })

async function setup(count: number) {
  let res = await foldersRoute.POST(post("/api/folders", { name: "F" }))
  const folder = (await res.json()).data
  res = await tubesRoute.POST(
    post("/api/tubes", { folderId: folder.id, name: "T" })
  )
  const tube = (await res.json()).data as { id: string }
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    res = await tubeItemsRoute.POST(
      post(`/api/tubes/${tube.id}/items`, { payload: { n: i } }),
      params({ id: tube.id })
    )
    ids.push((await res.json()).data.id)
  }
  return { tubeId: tube.id, ids }
}

const next = (tubeId: string, query: string) =>
  nextRoute.GET(
    new Request(`http://localhost/api/tubes/${tubeId}/next?${query}`),
    params({ id: tubeId })
  )

describe("GET /api/tubes/{id}/next", () => {
  it("returns the next item's payload and completes it", async () => {
    const { tubeId, ids } = await setup(2)
    const first = await next(tubeId, `api_key=${SECRET}`)
    expect(first.headers.get("cache-control")).toBe("no-store")
    expect(await first.json()).toBe(0)
    expect(
      await (await next(tubeId, `api_key=${SECRET}&agent_id=cron-1`)).json()
    ).toBe(1)

    const stored = await itemRoute.GET(
      new Request(`http://localhost/api/items/${ids[0]}`, { headers: auth }),
      params({ id: ids[0] })
    )
    expect((await stored.json()).data).toMatchObject({ status: "completed" })

    const empty = await next(tubeId, `api_key=${SECRET}`)
    expect(empty.status).toBe(204)
    expect(await empty.text()).toBe("")
  })

  it("unwraps single-field payloads (strings as plain text)", async () => {
    const { tubeId } = await setup(0)
    for (const payload of [
      { url: "https://a.test" },
      { tags: ["x", "y"] },
      { a: 1, b: 2 },
    ]) {
      await tubeItemsRoute.POST(
        post(`/api/tubes/${tubeId}/items`, { payload }),
        params({ id: tubeId })
      )
    }
    const text = await next(tubeId, `api_key=${SECRET}`)
    expect(text.headers.get("content-type")).toMatch(/^text\/plain/)
    expect(await text.text()).toBe("https://a.test")
    expect(await (await next(tubeId, `api_key=${SECRET}`)).json()).toEqual([
      "x",
      "y",
    ])
    expect(await (await next(tubeId, `api_key=${SECRET}`)).json()).toEqual({
      a: 1,
      b: 2,
    })
  })

  it("rejects requests without a key", async () => {
    const { tubeId } = await setup(1)
    expect((await next(tubeId, "")).status).toBe(401)
  })
})

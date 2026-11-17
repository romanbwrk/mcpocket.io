import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  adminConfigFromEnv,
  createSessionToken,
  SESSION_COOKIE,
} from "@mcpocket/core/auth/session"
import { createMemoryMediaStore, resetMediaStore } from "@mcpocket/core/media"
import { signMediaUrl } from "@mcpocket/core/media/links"
import { resetStorageSingleton } from "@mcpocket/core/storage"

import * as foldersRoute from "../folders/route"
import * as itemsRoute from "../tubes/[id]/items/route"
import * as tubesRoute from "../tubes/route"
import * as filesRoute from "./files/[...key]/route"
import * as linksRoute from "./links/route"
import * as mediaRoute from "./route"

const SECRET = "test-secret-123"
let dataDir: string
let store: ReturnType<typeof createMemoryMediaStore>

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-media-routes-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_API_KEYS", `ci:${SECRET}`)
  await resetStorageSingleton()
  store = createMemoryMediaStore({ maxBytes: 32 })
  resetMediaStore(store)
})
afterEach(async () => {
  resetMediaStore()
  await resetStorageSingleton()
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

const req = (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${SECRET}`)
  return new Request(`http://localhost${url}`, { ...init, headers })
}
const postJson = (url: string, body: unknown) =>
  req(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })

describe("media REST routes", () => {
  it("reports status", async () => {
    const res = await mediaRoute.GET(req("/api/media"))
    expect(await res.json()).toEqual({
      data: {
        enabled: true,
        maxBytes: 32,
        allowedTypes: [],
        access: "private",
      },
    })
  })

  it("uploads raw and multipart bodies", async () => {
    const raw = await mediaRoute.POST(
      req("/api/media?filename=a.png", {
        method: "POST",
        body: "png-bytes",
        headers: { "content-type": "image/png" },
      })
    )
    expect(raw.status).toBe(201)
    expect((await raw.json()).data).toMatchObject({
      contentType: "image/png",
      size: 9,
      filename: "a.png",
      url: expect.stringMatching(/^https:\/\/media\.test\/media\/.+\.png$/),
    })

    const form = new FormData()
    form.set("file", new File(["%PDF"], "doc.pdf", { type: "application/pdf" }))
    const multi = await mediaRoute.POST(
      req("/api/media", { method: "POST", body: form })
    )
    expect(multi.status).toBe(201)
    expect((await multi.json()).data).toMatchObject({
      contentType: "application/pdf",
      filename: "doc.pdf",
    })
    expect(store.objects.size).toBe(2)
  })

  it("rejects oversized and empty uploads", async () => {
    const big = await mediaRoute.POST(
      req("/api/media", {
        method: "POST",
        body: "x".repeat(64),
        headers: { "content-type": "image/png" },
      })
    )
    expect(big.status).toBe(413)
    const empty = await mediaRoute.POST(
      req("/api/media", {
        method: "POST",
        body: "",
        headers: { "content-type": "image/png" },
      })
    )
    expect(empty.status).toBe(400)
  })

  it("is 409 when media is disabled", async () => {
    resetMediaStore(null)
    const res = await mediaRoute.POST(
      req("/api/media", {
        method: "POST",
        body: "x",
        headers: { "content-type": "image/png" },
      })
    )
    expect(res.status).toBe(409)
  })

  it("item push replaces data URIs with URLs", async () => {
    const folder = (
      await (
        await foldersRoute.POST(postJson("/api/folders", { name: "f" }))
      ).json()
    ).data
    const tube = (
      await (
        await tubesRoute.POST(
          postJson("/api/tubes", { folderId: folder.id, name: "t" })
        )
      ).json()
    ).data
    const uri = `data:image/png;base64,${Buffer.from("img").toString("base64")}`
    const res = await itemsRoute.POST(
      postJson(`/api/tubes/${tube.id}/items`, { payload: { image: uri } }),
      { params: Promise.resolve({ id: tube.id }) }
    )
    expect(res.status).toBe(201)
    const { data } = await res.json()
    expect(data.payload.image).toMatch(/^https:\/\/media\.test\/media\//)
  })
})

describe("GET /api/media/files/{key} (public media)", () => {
  const BYTES = Buffer.from("0123456789")
  const SHA = "a".repeat(64)
  const KEY = `media/aa/${SHA}.mp4`
  const get = (key: string, headers: Record<string, string> = {}) =>
    filesRoute.GET(
      new Request(`http://localhost/api/media/files/${key}`, { headers }),
      { params: Promise.resolve({ key: key.split("/") }) }
    )

  beforeEach(async () => {
    vi.stubEnv("MCPOCKET_MEDIA_ACCESS", "public")
    await store.put({
      key: KEY,
      body: new Uint8Array(BYTES),
      contentType: "video/mp4",
    })
  })

  it("streams an object without an API key, with caching headers", async () => {
    const res = await get(KEY)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true)
    expect(res.headers.get("content-type")).toBe("video/mp4")
    expect(res.headers.get("content-length")).toBe("10")
    expect(res.headers.get("etag")).toBe(`"${SHA}"`)
    expect(res.headers.get("cache-control")).toContain("immutable")
    expect(res.headers.get("content-security-policy")).toContain("sandbox")
    expect((await get(KEY, { "if-none-match": `"${SHA}"` })).status).toBe(304)
  })

  it("answers ranges (video seeking)", async () => {
    const part = await get(KEY, { range: "bytes=2-5" })
    expect(part.status).toBe(206)
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(await part.text()).toBe("2345")
    const tail = await get(KEY, { range: "bytes=-3" })
    expect(await tail.text()).toBe("789")
    const bad = await get(KEY, { range: "bytes=50-" })
    expect(bad.status).toBe(416)
    expect(bad.headers.get("content-range")).toBe("bytes */10")
  })

  it("serves only media keys; HEAD gives the size", async () => {
    expect((await get(`media/aa/${"b".repeat(64)}.mp4`)).status).toBe(404)
    expect((await get("other/secret.txt")).status).toBe(404)
    expect((await get("media/../x")).status).toBe(404)
    const head = await filesRoute.HEAD(
      new Request(`http://localhost/api/media/files/${KEY}`, {
        method: "HEAD",
      }),
      { params: Promise.resolve({ key: KEY.split("/") }) }
    )
    expect(head.status).toBe(200)
    expect(head.headers.get("content-length")).toBe("10")
  })

  it("never lets uploaded HTML / SVG render on this origin", async () => {
    const svg = `media/bb/${"b".repeat(64)}.svg`
    await store.put({
      key: svg,
      body: new Uint8Array(Buffer.from("<svg/>")),
      contentType: "image/svg+xml",
    })
    const res = await get(svg)
    expect(res.headers.get("content-disposition")).toBe("attachment")
  })
})

describe("private media (default)", () => {
  const SHA = "c".repeat(64)
  const KEY = `media/cc/${SHA}.mp3`
  const BASE = "http://localhost/api/media/files"
  const fileUrl = `${BASE}/${KEY}`
  const get = (url: string, headers: Record<string, string> = {}) =>
    filesRoute.GET(new Request(url, { headers }), {
      params: Promise.resolve({ key: KEY.split("/") }),
    })

  beforeEach(async () => {
    const own = createMemoryMediaStore({ maxBytes: 32 }, BASE)
    resetMediaStore(own)
    await own.put({
      key: KEY,
      body: new Uint8Array(Buffer.from("call-audio")),
      contentType: "audio/mpeg",
    })
  })

  it("refuses anonymous requests", async () => {
    const res = await get(fileUrl)
    expect(res.status).toBe(401)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(
      await get(`${fileUrl}?exp=9999999999&sig=forged`).then((r) => r.status)
    ).toBe(401)
  })

  it("serves API keys privately", async () => {
    const res = await get(fileUrl, { authorization: `Bearer ${SECRET}` })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("call-audio")
    expect(res.headers.get("cache-control")).toMatch(/^private/)
    expect(res.headers.get("vary")).toContain("Authorization")
    expect((await get(fileUrl, { authorization: "Bearer wrong" })).status).toBe(
      401
    )
  })

  it("serves dashboard sessions", async () => {
    vi.stubEnv("MCPOCKET_ADMIN_PASSWORD", "pw-123456")
    const { token } = createSessionToken(adminConfigFromEnv())
    const res = await get(fileUrl, {
      cookie: `other=1; ${SESSION_COOKIE}=${token}`,
    })
    expect(res.status).toBe(200)
  })

  it("serves signed links until they expire", async () => {
    const created = await linksRoute.POST(
      postJson("/api/media/links", { url: fileUrl, expiresInSeconds: 120 })
    )
    const body = await created.json()
    expect(body.summary).toMatchObject({ succeeded: 1 })
    const { link, url, expiresAt } = body.results[0].data
    expect(url).toBe(fileUrl)
    expect(link).toMatch(/\?exp=\d+&sig=/)
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now())

    const res = await get(link)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toMatch(
      /^public, max-age=1(19|20)$/
    )
    // The signature is bound to the key and the expiry.
    const tampered = link.replace(
      /exp=(\d+)/,
      (_: string, n: string) => `exp=${Number(n) + 1}`
    )
    expect((await get(tampered)).status).toBe(401)
    const expired = signMediaUrl(
      fileUrl,
      KEY,
      Math.floor(Date.now() / 1000) - 1
    )
    expect((await get(expired)).status).toBe(401)

    const other = await linksRoute.POST(
      postJson("/api/media/links", { url: "https://elsewhere.test/a.mp3" })
    )
    expect((await other.json()).results[0]).toMatchObject({ ok: false })
  })
})

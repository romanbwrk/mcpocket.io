import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { PayloadTooLargeError, ValidationError } from "../domain/errors"
import type { Tube } from "../domain/schemas"
import { createServiceContext, createServices } from "../services"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

import { isAllowedType, mediaConfigFromEnv } from "./config"
import { parseDataUriHeader } from "./data-uri"
import { createMediaMaterializer } from "./materialize"
import { createMemoryMediaStore, publicUrlFor } from "./store"

const PNG = Buffer.from("fake-png-bytes")
const PNG_URI = `data:image/png;base64,${PNG.toString("base64")}`
const PNG_SHA = createHash("sha256").update(PNG).digest("hex")
const PNG_URL = `https://media.test/media/${PNG_SHA.slice(0, 2)}/${PNG_SHA}.png`

describe("data URIs", () => {
  it("parses type, base64 flag and filename", () => {
    expect(
      parseDataUriHeader("data:video/mp4;name=clip%201.mp4;base64,AAAA")
    ).toEqual({
      contentType: "video/mp4",
      filename: "clip 1.mp4",
      base64: true,
      dataStart: 40,
    })
    expect(parseDataUriHeader("data:,plain text")).toBeNull()
    expect(parseDataUriHeader("https://x.test/a.png")).toBeNull()
    expect(parseDataUriHeader("data:notamime,xx")).toBeNull()
  })
})

describe("media config", () => {
  it("is disabled without a bucket", () => {
    expect(mediaConfigFromEnv({})).toBeNull()
  })

  it("reads S3-compatible settings", () => {
    const config = mediaConfigFromEnv({
      MCPOCKET_S3_BUCKET: "b",
      MCPOCKET_S3_ENDPOINT: "http://minio:9000/",
      MCPOCKET_S3_ACCESS_KEY_ID: "k",
      MCPOCKET_S3_SECRET_ACCESS_KEY: "s",
      MCPOCKET_MEDIA_PREFIX: "/uploads",
      MCPOCKET_MEDIA_ALLOWED_TYPES: "image/*, application/pdf",
    })!
    expect(config).toMatchObject({
      bucket: "b",
      endpoint: "http://minio:9000",
      forcePathStyle: true,
      prefix: "uploads/",
      allowedTypes: ["image/*", "application/pdf"],
      delivery: "server",
    })
    const bucket = { ...config, delivery: "bucket" as const }
    expect(publicUrlFor(bucket, "uploads/a b.png")).toBe(
      "http://minio:9000/b/uploads/a%20b.png"
    )
    expect(
      publicUrlFor({ ...config, publicUrl: "https://cdn.test" }, "k.png")
    ).toBe("https://cdn.test/k.png")
    expect(
      publicUrlFor(
        mediaConfigFromEnv({
          MCPOCKET_S3_BUCKET: "b",
          MCPOCKET_MEDIA_DELIVERY: "bucket",
        })!,
        "k.png"
      )
    ).toBe("https://b.s3.us-east-1.amazonaws.com/k.png")
  })

  it("puts each workspace under its own prefix", () => {
    const base = { MCPOCKET_S3_BUCKET: "b" }
    expect(mediaConfigFromEnv(base)!.prefix).toBe("media/")
    expect(
      mediaConfigFromEnv({ ...base, MCPOCKET_SSO_WORKSPACE: "acme" })!.prefix
    ).toBe("media/acme/")
    expect(
      mediaConfigFromEnv({
        ...base,
        MCPOCKET_MEDIA_PREFIX: "uploads",
        MCPOCKET_WORKSPACE: "beta",
        MCPOCKET_SSO_WORKSPACE: "acme",
      })!.prefix
    ).toBe("uploads/beta/")
    expect(() =>
      mediaConfigFromEnv({ ...base, MCPOCKET_WORKSPACE: "../x" })
    ).toThrow(/workspace/)
  })

  it("serves through this server by default", () => {
    const config = mediaConfigFromEnv({ MCPOCKET_S3_BUCKET: "b" })!
    expect(config.delivery).toBe("server")
    expect(publicUrlFor(config, "media/ab/x.png", "https://pocket.test")).toBe(
      "https://pocket.test/api/media/files/media/ab/x.png"
    )
    const pinned = mediaConfigFromEnv({
      MCPOCKET_S3_BUCKET: "b",
      MCPOCKET_PUBLIC_URL: "https://ws.example.com/",
    })!
    expect(publicUrlFor(pinned, "media/ab/x.png", "http://10.0.0.5:3000")).toBe(
      "https://ws.example.com/api/media/files/media/ab/x.png"
    )
    expect(() =>
      mediaConfigFromEnv({
        MCPOCKET_S3_BUCKET: "b",
        MCPOCKET_MEDIA_DELIVERY: "cdn",
      })
    ).toThrow(/MCPOCKET_MEDIA_DELIVERY/)
  })

  it("rejects half-set credentials", () => {
    expect(() =>
      mediaConfigFromEnv({
        MCPOCKET_S3_BUCKET: "b",
        MCPOCKET_S3_ACCESS_KEY_ID: "k",
      })
    ).toThrow(/both/)
  })

  it("matches type wildcards", () => {
    expect(isAllowedType("image/png", [])).toBe(true)
    expect(isAllowedType("image/png", ["image/*"])).toBe(true)
    expect(isAllowedType("video/mp4", ["image/*"])).toBe(false)
  })
})

describe("materializer", () => {
  it("uploads nested data URIs once and replaces them by URL", async () => {
    const store = createMemoryMediaStore()
    const materialize = createMediaMaterializer(store)
    const value = {
      title: "x",
      cover: PNG_URI,
      gallery: [PNG_URI, { src: PNG_URI }],
      link: "https://example.test/a.png",
    }
    const out = await materialize(value, "payload")
    expect(out).toEqual({
      title: "x",
      cover: PNG_URL,
      gallery: [PNG_URL, { src: PNG_URL }],
      link: "https://example.test/a.png",
    })
    expect(value.cover).toBe(PNG_URI) // input not mutated
    expect([...store.objects.values()]).toEqual([
      expect.objectContaining({ contentType: "image/png", body: PNG }),
    ])
  })

  it("passes values through when media is disabled or absent", async () => {
    const value = { cover: PNG_URI }
    expect(await createMediaMaterializer(null)(value, "payload")).toBe(value)
    const plain = { a: 1 }
    expect(
      await createMediaMaterializer(createMemoryMediaStore())(plain, "payload")
    ).toBe(plain)
  })

  it("validates every URI before uploading anything", async () => {
    const store = createMemoryMediaStore({
      maxBytes: 8,
      allowedTypes: ["image/*"],
    })
    const materialize = createMediaMaterializer(store)
    await expect(
      materialize({ a: "data:image/png;base64,AAAA", b: PNG_URI }, "payload")
    ).rejects.toBeInstanceOf(PayloadTooLargeError)
    await expect(
      materialize({ doc: "data:application/pdf;base64,AAAA" }, "payload")
    ).rejects.toMatchObject({ details: { path: "payload.doc" } })
    await expect(
      materialize({ bad: "data:image/png;base64,***" }, "payload")
    ).rejects.toBeInstanceOf(ValidationError)
    expect(store.objects.size).toBe(0)
  })
})

describe("items with media", () => {
  let dataDir: string
  let storage: Storage
  let store: ReturnType<typeof createMemoryMediaStore>
  let services: ReturnType<typeof createServices>
  let tube: Tube

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-media-"))
    storage = await createJsonStorage({ dataDir })
    store = createMemoryMediaStore({ maxBytes: 64 })
    services = createServices(createServiceContext(storage, { media: store }), {
      kind: "agent",
      id: "bot-1",
    })
    const folder = await services.folders.create({ name: "f" })
    tube = await services.tubes.create({ folderId: folder.id, name: "t" })
  })
  afterEach(async () => {
    await storage.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it("push stores URLs in payload and metadata", async () => {
    const { item } = await services.items.push(tube.id, {
      payload: { image: PNG_URI },
      metadata: { thumb: PNG_URI },
    })
    expect(item.payload).toEqual({ image: PNG_URL })
    expect(item.metadata).toEqual({ thumb: PNG_URL })
    expect(store.objects.size).toBe(1)
    const history = await services.items.history(item.id)
    expect(JSON.stringify(history.data)).not.toContain("base64")
  })

  it("bulk push fails only the entry with oversized media", async () => {
    const big = `data:image/png;base64,${Buffer.alloc(100).toString("base64")}`
    const result = await services.items.bulkPush(tube.id, {
      items: [{ payload: { image: PNG_URI } }, { payload: { image: big } }],
    })
    expect(result.summary).toMatchObject({ succeeded: 1, failed: 1 })
    expect(result.results[0]).toMatchObject({
      ok: true,
      data: { payload: { image: PNG_URL } },
    })
    expect(result.results[1]).toMatchObject({
      ok: false,
      error: { code: "payload_too_large" },
    })
  })

  it("update and bulk update replace data URIs", async () => {
    const { item } = await services.items.push(tube.id, { payload: { a: 1 } })
    const updated = await services.items.update(item.id, {
      payload: { a: 1, file: PNG_URI },
    })
    expect(updated.payload).toEqual({ a: 1, file: PNG_URL })
    const bulk = await services.items.bulkUpdate({
      ids: [item.id],
      patch: { metadata: { cover: PNG_URI } },
    })
    expect(bulk.results[0]).toMatchObject({
      ok: true,
      data: { metadata: { cover: PNG_URL } },
    })
  })

  it("direct upload returns a media object", async () => {
    const media = await services.media.upload({
      body: new Uint8Array(PNG),
      contentType: "image/png; charset=binary",
      filename: "a.png",
    })
    expect(media).toEqual({
      url: PNG_URL,
      key: `media/${PNG_SHA.slice(0, 2)}/${PNG_SHA}.png`,
      contentType: "image/png",
      size: PNG.length,
      sha256: PNG_SHA,
      filename: "a.png",
    })
  })

  it("direct upload is a conflict when media is disabled", async () => {
    const off = createServices(createServiceContext(storage, { media: null }), {
      kind: "agent",
      id: "bot-1",
    })
    expect(off.media.status()).toEqual({ enabled: false })
    await expect(
      off.media.upload({ body: new Uint8Array(PNG), contentType: "image/png" })
    ).rejects.toMatchObject({ code: "conflict" })
  })
})

describe("media library", () => {
  let dataDir: string
  let storage: Storage
  let store: ReturnType<typeof createMemoryMediaStore>
  let services: ReturnType<typeof createServices>
  let tube: Tube

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-media-lib-"))
    storage = await createJsonStorage({ dataDir })
    store = createMemoryMediaStore()
    services = createServices(createServiceContext(storage, { media: store }), {
      kind: "api_key",
      id: "ci",
    })
    const folder = await services.folders.create({ name: "f" })
    tube = await services.tubes.create({ folderId: folder.id, name: "pics" })
  })
  afterEach(async () => {
    await storage.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const PDF = `data:application/pdf;base64,${Buffer.from("%PDF").toString("base64")}`

  it("lists newest first with kinds, totals and usage counts", async () => {
    const { item } = await services.items.push(tube.id, {
      payload: { image: PNG_URI, again: PNG_URI },
    })
    await services.media.upload({
      body: new Uint8Array(Buffer.from("%PDF")),
      contentType: "application/pdf",
    })

    const all = await services.media.list()
    expect(all.data.map((e) => [e.kind, e.usedBy])).toEqual([
      ["document", 0],
      ["image", 1],
    ])
    expect(all.data[1]).toMatchObject({
      url: PNG_URL,
      contentType: "image/png",
    })
    expect(all.summary).toMatchObject({
      count: 2,
      bytes: PNG.length + 4,
      unused: 1,
      byKind: { image: { count: 1 }, document: { count: 1 } },
    })
    expect(all.page).toEqual({ offset: 0, limit: 48, total: 2 })

    expect((await services.media.list({ kind: "image" })).data).toHaveLength(1)
    expect(
      (await services.media.list({ usage: "unused" })).data.map((e) => e.kind)
    ).toEqual(["document"])

    const usage = await services.media.usage(all.data[1].key)
    expect(usage.items).toEqual([
      {
        id: item.id,
        tubeId: tube.id,
        tubeName: "pics",
        status: "pending",
        fields: ["payload"],
      },
    ])

    // Soft-deleted items no longer count as users.
    await services.items.delete(item.id)
    expect((await services.media.list({ usage: "unused" })).page.total).toBe(2)
  })

  it("lists one tube's media with counts for that tube only", async () => {
    const other = await services.tubes.create({
      folderId: tube.folderId!,
      name: "other",
    })
    await services.items.push(tube.id, { payload: { image: PNG_URI } })
    await services.items.push(tube.id, {
      metadata: { cover: PNG_URI },
      payload: {},
    })
    await services.items.push(other.id, {
      payload: { image: PNG_URI, doc: PDF },
    })

    const mine = await services.media.list({ tubeId: tube.id })
    expect(mine.data.map((e) => [e.kind, e.usedBy])).toEqual([["image", 2]])
    expect(mine.summary).toMatchObject({ count: 1, unused: 0 })

    const theirs = await services.media.list({ tubeId: other.id })
    expect(theirs.data.map((e) => [e.kind, e.usedBy]).sort()).toEqual([
      ["document", 1],
      ["image", 1],
    ])
    expect(
      (await services.media.list({ tubeId: other.id, kind: "document" })).page
        .total
    ).toBe(1)
    await expect(
      services.media.list({ tubeId: "00000000-0000-4000-8000-000000000000" })
    ).rejects.toMatchObject({ code: "not_found" })
  })

  it("deletes only existing objects under the media prefix", async () => {
    await services.items.push(tube.id, { payload: { doc: PDF } })
    const [entry] = (await services.media.list()).data
    await expect(services.media.delete("other/x.png")).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(
      services.media.delete("media/../secret.txt")
    ).rejects.toMatchObject({ code: "validation_error" })
    await expect(
      services.media.delete("media/00/missing.png")
    ).rejects.toMatchObject({ code: "not_found" })
    expect(await services.media.delete(entry.key)).toEqual({ key: entry.key })
    expect(store.objects.size).toBe(0)
  })

  it("is a conflict when media is disabled", async () => {
    const off = createServices(createServiceContext(storage, { media: null }), {
      kind: "api_key",
      id: "ci",
    })
    await expect(off.media.list()).rejects.toMatchObject({ code: "conflict" })
  })
})

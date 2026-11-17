import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"

import { ValidationError } from "../domain/errors"
import {
  authorizeUpload,
  createServiceContext,
  createServices,
  uploadWithToken,
  type ServiceContext,
} from "../services"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

import {
  assertFetchableUrl,
  createHttpMediaFetcher,
  isPublicAddress,
  type MediaFetcher,
} from "./ingest"
import { createMemoryMediaStore } from "./store"
import {
  createUploadToken,
  resetUploadSigningKey,
  UPLOAD_SECRET_FILE,
  uploadSigningKey,
} from "./upload-token"

const PNG = Buffer.from("remote-png")
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")

describe("SSRF guard", () => {
  it("classifies addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "169.254.169.254",
      "172.20.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false)
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) {
      expect(isPublicAddress(ip), ip).toBe(true)
    }
  })

  it("rejects bad URLs before fetching", () => {
    expect(() => assertFetchableUrl("file:///etc/passwd")).toThrow(
      ValidationError
    )
    expect(() => assertFetchableUrl("https://u:p@x.test/a.png")).toThrow(
      ValidationError
    )
    expect(() => assertFetchableUrl("http://127.0.0.1/a")).toThrow(/non-public/)
    expect(() => assertFetchableUrl("http://[::1]/a")).toThrow(/non-public/)
    expect(() => assertFetchableUrl("nope")).toThrow(/Invalid URL/)
    expect(assertFetchableUrl("http://127.0.0.1/a", true).host).toBe(
      "127.0.0.1"
    )
  })
})

describe("http media fetcher", () => {
  let server: Server
  let base: string
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/img.png") {
        res.writeHead(200, { "content-type": "image/png" })
        return res.end(PNG)
      }
      if (req.url === "/blob/clip.mp4") {
        res.writeHead(200, { "content-type": "application/octet-stream" })
        return res.end(Buffer.from("mp4"))
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/img.png" })
        return res.end()
      }
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "image/png" })
        return res.end(Buffer.alloc(2000))
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  const open = createHttpMediaFetcher({
    allowPrivate: true,
    timeoutMs: 5000,
    maxRedirects: 5,
  })

  it("downloads, follows redirects and guesses generic types", async () => {
    const got = await open(`${base}/redirect`, { maxBytes: 1000 })
    expect(Buffer.from(got.body).equals(PNG)).toBe(true)
    expect(got).toMatchObject({
      contentType: "image/png",
      filename: "img.png",
      finalUrl: `${base}/img.png`,
    })
    const clip = await open(`${base}/blob/clip.mp4`, { maxBytes: 1000 })
    expect(clip.contentType).toBe("video/mp4")
  })

  it("enforces size and status", async () => {
    await expect(open(`${base}/big`, { maxBytes: 100 })).rejects.toMatchObject({
      code: "payload_too_large",
    })
    await expect(open(`${base}/missing`, { maxBytes: 100 })).rejects.toThrow(
      /HTTP 404/
    )
  })

  it("blocks hosts resolving to private addresses", async () => {
    const guarded = createHttpMediaFetcher({
      allowPrivate: false,
      timeoutMs: 5000,
      maxRedirects: 5,
    })
    const port = (server.address() as AddressInfo).port
    await expect(
      guarded(`http://localhost:${port}/img.png`, { maxBytes: 1000 })
    ).rejects.toThrow(/non-public/)
  })
})

describe("media service: ingest and upload links", () => {
  let dataDir: string
  let storage: Storage
  let ctx: ServiceContext
  let store: ReturnType<typeof createMemoryMediaStore>
  const fetched: string[] = []
  const fetcher: MediaFetcher = async (url) => {
    fetched.push(url)
    if (url.endsWith("/missing.png")) {
      throw new ValidationError(`Fetching ${url} failed: HTTP 404`, { url })
    }
    return {
      body: PNG,
      contentType: "image/png",
      filename: "cat.png",
      finalUrl: url,
    }
  }

  const ENV_KEYS = [
    "DATA_DIR",
    "MCPOCKET_SESSION_SECRET",
    "MCPOCKET_ADMIN_PASSWORD",
    "MCPOCKET_SSO_SECRET",
  ] as const
  let savedEnv: Record<string, string | undefined>

  beforeEach(async () => {
    fetched.length = 0
    dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-ingest-"))
    // No secret configured: the signing key is persisted in DATA_DIR.
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.DATA_DIR = dataDir
    resetUploadSigningKey()
    storage = await createJsonStorage({ dataDir })
    store = createMemoryMediaStore({ allowedTypes: ["image/*", "video/*"] })
    ctx = createServiceContext(storage, {
      media: store,
      mediaFetcher: fetcher,
      publicUrl: "https://pocket.test",
    })
  })
  afterEach(async () => {
    resetUploadSigningKey()
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    await storage.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it("persists the signing key in the data directory across restarts", async () => {
    const key = uploadSigningKey()
    const file = await readFile(path.join(dataDir, UPLOAD_SECRET_FILE), "utf8")
    expect(file).toMatch(/^[0-9a-f]{64}$/)
    resetUploadSigningKey() // "restart"
    expect(uploadSigningKey().equals(key)).toBe(true)

    // A configured session secret takes precedence.
    resetUploadSigningKey()
    process.env.MCPOCKET_SESSION_SECRET = "s".repeat(40)
    expect(uploadSigningKey().equals(key)).toBe(false)
  })

  const agent = () =>
    createServices(ctx, {
      kind: "agent",
      id: "bot",
      viaKeyId: "env-key",
      access: { role: "agent", scope: null },
    })

  it("ingests URLs into storage, per-entry results", async () => {
    const res = await agent().media.ingest({
      urls: [
        "https://gen.example/tmp/abc?sig=1",
        { url: "https://gen.example/missing.png" },
        { url: "https://gen.example/x", filename: "frame.png" },
      ],
    })
    expect(res.summary).toEqual({ total: 3, succeeded: 2, failed: 1 })
    const first = res.results[0]
    expect(first).toMatchObject({
      ok: true,
      data: {
        url: `https://media.test/media/${sha(PNG).slice(0, 2)}/${sha(PNG)}.png`,
        sourceUrl: "https://gen.example/tmp/abc?sig=1",
        contentType: "image/png",
        size: PNG.length,
        filename: "cat.png",
      },
    })
    expect(res.results[1]).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    })
    expect(res.results[2]).toMatchObject({
      ok: true,
      data: { filename: "frame.png" },
    })
    expect(store.objects.size).toBe(1) // content-addressed

    // Own URLs are not fetched again.
    fetched.length = 0
    const again = await agent().media.ingest({
      url: (first as { data: { url: string } }).data.url,
    })
    expect(again.results[0]).toMatchObject({
      ok: true,
      data: { reused: true, sha256: sha(PNG) },
    })
    expect(fetched).toEqual([])
  })

  it("needs items:push, media storage and one of url/urls", async () => {
    const reader = createServices(ctx, {
      kind: "api_key",
      id: "r",
      access: { role: "readonly", scope: null },
    })
    await expect(
      reader.media.ingest({ url: "https://x.test/a.png" })
    ).rejects.toMatchObject({ code: "forbidden" })
    await expect(agent().media.ingest({})).rejects.toThrow(/either url or urls/)
    const off = createServices(
      createServiceContext(storage, { media: null, mediaFetcher: fetcher }),
      { kind: "api_key", id: "ci" }
    )
    await expect(
      off.media.ingest({ url: "https://x.test/a.png" })
    ).rejects.toMatchObject({ code: "conflict" })
  })

  it("creates signed upload links that store a file", async () => {
    const prev = process.env.MCPOCKET_API_KEYS
    process.env.MCPOCKET_API_KEYS = "env-key:secret-1"
    try {
      const link = agent().media.createUploadLink({
        contentType: "video/mp4",
        filename: "clip.mp4",
      })
      expect(link.uploadUrl).toMatch(
        /^https:\/\/pocket\.test\/api\/media\/uploads\/[\w-]+\.[\w-]+$/
      )
      expect(link.curl).toContain("Content-Type: video/mp4")
      const token = link.uploadUrl.split("/").pop()!

      const auth = await authorizeUpload(ctx, token)
      const stored = await uploadWithToken(ctx, auth, {
        body: new Uint8Array(Buffer.from("mp4-bytes")),
        contentType: "video/mp4",
      })
      expect(stored).toMatchObject({
        contentType: "video/mp4",
        filename: "clip.mp4",
      })

      await expect(
        uploadWithToken(ctx, auth, {
          body: new Uint8Array([1]),
          contentType: "image/png",
        })
      ).rejects.toMatchObject({ code: "validation_error" })
      await expect(authorizeUpload(ctx, `${token}x`)).rejects.toMatchObject({
        code: "unauthorized",
      })
      const expired = createUploadToken(
        { k: "env-key", e: 1 },
        uploadSigningKey()
      )
      await expect(authorizeUpload(ctx, expired)).rejects.toMatchObject({
        code: "unauthorized",
      })
      const unknown = createUploadToken(
        { k: "gone", e: 4e9 },
        uploadSigningKey()
      )
      await expect(authorizeUpload(ctx, unknown)).rejects.toMatchObject({
        code: "unauthorized",
      })
    } finally {
      if (prev === undefined) delete process.env.MCPOCKET_API_KEYS
      else process.env.MCPOCKET_API_KEYS = prev
    }
  })

  it("rejects disallowed types and callers without an API key", () => {
    expect(() =>
      agent().media.createUploadLink({ contentType: "application/pdf" })
    ).toThrow(/not allowed/)
    const system = createServices(ctx, { kind: "system", id: "sys" })
    expect(() => system.media.createUploadLink()).toThrow(/API key/)
  })
})

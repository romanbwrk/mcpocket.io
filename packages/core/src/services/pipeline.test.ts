import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Actor } from "../domain/actor"
import type { Tube } from "../domain/schemas"
import { narrowActor } from "../mcp/connection-scope"
import { createMemoryMediaStore } from "../media/store"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

import { createServiceContext, createServices, type ServiceContext } from "."

/** `complete { next }`: prompts → images → videos pipelines. */

let dataDir: string
let storage: Storage
let ctx: ServiceContext
let store: ReturnType<typeof createMemoryMediaStore>
let prompts: Tube
let images: Tube
let videos: Tube
let nowMs: number

const agent = (id: string): Actor => ({ kind: "agent", id })
const as = (id: string) => createServices(ctx, agent(id))
const PNG = `data:image/png;base64,${Buffer.from("png").toString("base64")}`
const MP4 = `data:video/mp4;base64,${Buffer.from("mp4").toString("base64")}`

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-pipeline-"))
  storage = await createJsonStorage({ dataDir })
  store = createMemoryMediaStore()
  nowMs = Date.UTC(2026, 0, 1)
  ctx = createServiceContext(storage, {
    clock: { now: () => new Date(nowMs++) },
    leaseSeconds: 60,
    media: store,
  })
  const admin = createServices(ctx, { kind: "api_key", id: "ci" })
  const folder = await admin.folders.create({ name: "media" })
  prompts = await admin.tubes.create({ folderId: folder.id, name: "prompts" })
  images = await admin.tubes.create({ folderId: folder.id, name: "images" })
  videos = await admin.tubes.create({ folderId: folder.id, name: "videos" })
})
afterEach(async () => {
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

async function claim(bot: string, tube: Tube) {
  const claimed = await as(bot).processing.claim({ tubeId: tube.id })
  expect(claimed).not.toBeNull()
  return claimed!.item
}

describe("complete with next items", () => {
  it("hands output through prompts → images → videos with media as URLs", async () => {
    const { item: prompt } = await as("producer").items.push(prompts.id, {
      payload: { prompt: "a cat on the moon" },
    })

    // Stage 1: image generator.
    const p = await claim("imager", prompts)
    const stage1 = await as("imager").processing.completeWithNext(p.id, {
      result: { image: PNG },
      next: {
        tubeId: images.id,
        payload: { prompt: "a cat on the moon", image: PNG },
        tags: ["gen-1"],
      },
    })
    expect(stage1.item).toMatchObject({ status: "completed" })
    const imageUrl = (stage1.item.result as { image: string }).image
    expect(imageUrl).toMatch(/^https:\/\/media\.test\/media\/.+\.png$/)
    expect(stage1.next).toHaveLength(1)
    expect(stage1.next[0]).toMatchObject({
      tubeId: images.id,
      status: "pending",
      payload: { prompt: "a cat on the moon", image: imageUrl },
      tags: ["gen-1"],
      metadata: {
        source: {
          tubeId: prompts.id,
          itemId: prompt.id,
          root: { tubeId: prompts.id, itemId: prompt.id },
        },
      },
    })
    expect(store.objects.size).toBe(1) // same image uploaded once

    // Stage 2: video generator, fan-out to two items.
    const i = await claim("animator", images)
    expect(i.id).toBe(stage1.next[0].id)
    const stage2 = await as("animator").processing.completeWithNext(i.id, {
      next: [
        { tubeId: videos.id, payload: { firstFrame: imageUrl, video: MP4 } },
        { tubeId: videos.id, payload: { firstFrame: imageUrl, video: MP4 } },
      ],
    })
    expect(stage2.next).toHaveLength(2)
    expect(stage2.next[0].payload.video).toMatch(/\.mp4$/)
    expect(stage2.next[1].metadata.source).toEqual({
      tubeId: images.id,
      itemId: i.id,
      root: { tubeId: prompts.id, itemId: prompt.id },
    })

    const history = await as("x").items.history(i.id)
    expect(history.data[0]).toMatchObject({
      action: "completed",
      newValue: {
        next: stage2.next.map((n) => ({ tubeId: videos.id, itemId: n.id })),
      },
    })
  })

  it("writes nothing when a next item is rejected", async () => {
    const admin = createServices(ctx, { kind: "api_key", id: "ci" })
    await admin.tubes.update(images.id, {
      schemaDefinition: {
        type: "object",
        properties: { image: { type: "string" } },
        required: ["image"],
      },
    })
    await as("producer").items.push(prompts.id, { payload: { prompt: "x" } })
    const p = await claim("imager", prompts)

    await expect(
      as("imager").processing.completeWithNext(p.id, {
        next: [
          { tubeId: videos.id, payload: { ok: true } },
          { tubeId: images.id, payload: { wrong: 1 } },
        ],
      })
    ).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringMatching(/^next\[1\]: /),
    })
    expect((await as("x").items.get(p.id)).status).toBe("processing")
    expect((await as("x").items.list(videos.id)).page.total).toBe(0)

    await admin.tubes.update(videos.id, { enabled: false })
    await expect(
      as("imager").processing.complete(p.id, {
        next: { tubeId: videos.id, payload: {} },
      })
    ).rejects.toMatchObject({ code: "conflict" })
    await expect(
      as("imager").processing.complete(p.id, {
        next: { tubeId: "00000000-0000-4000-8000-000000000000", payload: {} },
      })
    ).rejects.toMatchObject({ code: "not_found" })
  })

  it("checks the lease before uploading media", async () => {
    await as("producer").items.push(prompts.id, { payload: { prompt: "x" } })
    const p = await claim("imager", prompts)
    await expect(
      as("intruder").processing.completeWithNext(p.id, {
        next: { tubeId: images.id, payload: { image: PNG } },
      })
    ).rejects.toMatchObject({ code: "forbidden" })
    expect(store.objects.size).toBe(0)
  })
})

describe("tube pipeline settings", () => {
  const admin = () => createServices(ctx, { kind: "api_key", id: "ci" })

  it("uses the tube's leaseSeconds for claims and heartbeats", async () => {
    await admin().tubes.update(videos.id, { leaseSeconds: 1800 })
    await as("p").items.push(videos.id, { payload: {} })
    const claimed = await as("v").processing.claim({ tubeId: videos.id })
    const lease = (iso: string) => Date.parse(iso) - nowMs
    expect(lease(claimed!.claim.leaseExpiresAt!)).toBeGreaterThan(1790_000)
    const beat = await as("v").processing.heartbeat(claimed!.item.id)
    expect(lease(beat.leaseExpiresAt!)).toBeGreaterThan(1790_000)
    const short = await as("v").processing.heartbeat(claimed!.item.id, {
      leaseSeconds: 10,
    })
    expect(lease(short.leaseExpiresAt!)).toBeLessThanOrEqual(10_000)

    // Other tubes keep the server default (60 s here).
    await as("p").items.push(images.id, { payload: {} })
    const other = await as("v").processing.claim({ tubeId: images.id })
    expect(lease(other!.claim.leaseExpiresAt!)).toBeLessThanOrEqual(60_000)

    const cleared = await admin().tubes.update(videos.id, {
      leaseSeconds: null,
    })
    expect(cleared.leaseSeconds).toBeUndefined()
  })

  it("validates nextTubeIds", async () => {
    const t = await admin().tubes.update(prompts.id, {
      nextTubeIds: [images.id, images.id],
    })
    expect(t.nextTubeIds).toEqual([images.id])
    await expect(
      admin().tubes.update(prompts.id, { nextTubeIds: [prompts.id] })
    ).rejects.toMatchObject({ code: "validation_error" })
    await expect(
      admin().tubes.update(prompts.id, {
        nextTubeIds: ["00000000-0000-4000-8000-000000000000"],
      })
    ).rejects.toMatchObject({ code: "not_found" })
    const cleared = await admin().tubes.update(prompts.id, { nextTubeIds: [] })
    expect(cleared.nextTubeIds).toBeUndefined()
    const created = await admin().tubes.create({
      name: "with next",
      nextTubeIds: [videos.id],
      leaseSeconds: 600,
    })
    expect(created).toMatchObject({
      nextTubeIds: [videos.id],
      leaseSeconds: 600,
    })
  })

  it("lets a tube-scoped agent hand off only to the tube's nextTubeIds", async () => {
    const bindTo = (scope: { folderIds: string[]; tubeIds: string[] } | null) =>
      createServices(
        ctx,
        narrowActor(
          { kind: "agent", id: "imager", access: { role: "agent", scope } },
          { kind: "tube", id: prompts.id }
        )
      )
    // One connection object for the whole test: settings changes made after
    // it bound must apply to it (no stale hand-off targets).
    const bound = bindTo(null)
    await as("p").items.push(prompts.id, { payload: { prompt: "x" } })
    const claimed = await bound.processing.claim({ tubeId: prompts.id })
    const id = claimed!.item.id

    // Not declared on the tube → invisible.
    await expect(
      bound.processing.complete(id, {
        next: { tubeId: images.id, payload: {} },
      })
    ).rejects.toMatchObject({ code: "not_found" })

    await admin().tubes.update(prompts.id, { nextTubeIds: [images.id] })
    // Declared, but the key itself only reaches the prompts tube.
    await expect(
      bindTo({ folderIds: [], tubeIds: [prompts.id] }).processing.complete(id, {
        next: { tubeId: images.id, payload: {} },
      })
    ).rejects.toMatchObject({ code: "not_found" })
    // Other tubes stay out of reach.
    await expect(
      bound.processing.complete(id, {
        next: { tubeId: videos.id, payload: {} },
      })
    ).rejects.toMatchObject({ code: "not_found" })

    const done = await bound.processing.completeWithNext(id, {
      next: { tubeId: images.id, payload: { image: PNG } },
    })
    expect(done.next[0]).toMatchObject({ tubeId: images.id, status: "pending" })
    // Still cannot read the hand-off tube.
    await expect(bound.tubes.get(images.id)).rejects.toMatchObject({
      code: "not_found",
    })

    // Removing the target takes effect on the same bound connection.
    await admin().tubes.update(prompts.id, { nextTubeIds: null })
    await as("p").items.push(prompts.id, { payload: { prompt: "y" } })
    const again = await bound.processing.claim({ tubeId: prompts.id })
    await expect(
      bound.processing.complete(again!.item.id, {
        next: { tubeId: images.id, payload: {} },
      })
    ).rejects.toMatchObject({ code: "not_found" })
  })
})

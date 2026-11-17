import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  adminConfigFromEnv,
  createSessionToken,
  SESSION_COOKIE,
} from "@mcpocket/core/auth/session"
import { cookieJar } from "@/lib/auth/test-utils"
import { EventBus, getEventBus } from "@mcpocket/core/events/bus"
import { createEventStreamResponse } from "@mcpocket/core/events/sse"
import type { DomainEvent } from "@mcpocket/core/events/types"
import { getServices } from "@mcpocket/core/services"
import { resetStorageSingleton } from "@mcpocket/core/storage"

import { GET } from "./route"

vi.mock("server-only", () => ({}))
vi.mock(
  "next/headers",
  async () => (await import("@/lib/auth/test-utils")).nextHeadersMock
)

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-sse-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_ADMIN_USERNAME", "boss")
  vi.stubEnv("MCPOCKET_ADMIN_PASSWORD", "pw-123456")
  vi.stubEnv("MCPOCKET_SESSION_SECRET", "s".repeat(40))
  await resetStorageSingleton()
  cookieJar.clear()
})
afterEach(async () => {
  await resetStorageSingleton()
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

function login() {
  const { token } = createSessionToken(adminConfigFromEnv())
  cookieJar.set(SESSION_COOKIE, { value: token })
}

const url = (search = "") => `http://localhost/api/dashboard/events${search}`

/** Reads SSE text until `done(buffer)` holds. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (text: string) => boolean,
  state: { text: string } = { text: "" }
): Promise<string> {
  const decoder = new TextDecoder()
  while (!done(state.text)) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`stream ended: ${state.text}`)
    state.text += decoder.decode(chunk.value, { stream: true })
  }
  return state.text
}

const domainEvents = (text: string): DomainEvent[] =>
  text
    .split("\n\n")
    .filter((block) => block.includes("event: domain"))
    .map((block) => JSON.parse(block.split("data: ")[1]))

describe("GET /api/dashboard/events", () => {
  it("requires a dashboard session (API keys are not accepted)", async () => {
    vi.stubEnv("MCPOCKET_API_KEYS", "ci:secret-123")
    const res = await GET(
      new Request(url(), { headers: { authorization: "Bearer secret-123" } })
    )
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe("unauthorized")
  })

  it("rejects malformed scope ids", async () => {
    login()
    const res = await GET(new Request(url("?tubeId=nope")))
    expect(res.status).toBe(400)
  })

  it("streams scoped events written through the services, then cleans up on disconnect", async () => {
    login()
    const admin = await getServices({ kind: "user", id: "boss" })
    const folder = await admin.folders.create({ name: "f" })
    const tubeA = await admin.tubes.create({ folderId: folder.id, name: "a" })
    const tubeB = await admin.tubes.create({ folderId: folder.id, name: "b" })

    const bus = getEventBus()
    const before = bus.listenerCount
    const abort = new AbortController()
    const res = await GET(
      new Request(url(`?tubeId=${tubeA.id}`), { signal: abort.signal })
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(res.headers.get("cache-control")).toContain("no-cache")
    expect(bus.listenerCount).toBe(before + 1)

    const reader = res.body!.getReader()
    const state = { text: "" }
    await readUntil(reader, (t) => t.includes("event: ready"), state)
    expect(state.text).toMatch(/^retry: \d+\n/)

    // A write in another tube is filtered out; tube A's write + structural events come through.
    const agent = await getServices({ kind: "agent", id: "bot-1" })
    await agent.items.push(tubeB.id, { payload: { skip: true } })
    const { item } = await agent.items.push(tubeA.id, { payload: { n: 1 } })
    await agent.processing.claim({ tubeId: tubeA.id })
    await admin.tubes.update(tubeB.id, { name: "b2" })

    await readUntil(reader, (t) => domainEvents(t).length >= 3, state)
    const events = domainEvents(state.text)
    expect(events.map((e) => e.type)).toEqual([
      "item.created",
      "item.status_changed",
      "tube.updated",
    ])
    expect(events[1]).toMatchObject({
      itemId: item.id,
      status: "processing",
      actor: "agent:bot-1",
    })
    expect(state.text).toMatch(new RegExp(`id: ${events[0].seq}\\n`))

    abort.abort()
    expect(bus.listenerCount).toBe(before)
    await expect(reader.read()).resolves.toMatchObject({ done: true })
  })
})

describe("createEventStreamResponse", () => {
  it("sends keep-alive pings and unsubscribes when the client cancels", async () => {
    const bus = new EventBus()
    const res = createEventStreamResponse({
      bus,
      scope: { kind: "global" },
      keepAliveMs: 10,
    })
    expect(bus.listenerCount).toBe(1)
    const reader = res.body!.getReader()
    await readUntil(reader, (t) => t.split(": ping").length > 2)
    await reader.cancel()
    expect(bus.listenerCount).toBe(0)
  })

  it("does not subscribe when the request is already aborted", async () => {
    const bus = new EventBus()
    const abort = new AbortController()
    abort.abort()
    const res = createEventStreamResponse({
      bus,
      scope: { kind: "global" },
      signal: abort.signal,
    })
    expect(bus.listenerCount).toBe(0)
    await expect(res.body!.getReader().read()).resolves.toMatchObject({
      done: true,
    })
  })
})

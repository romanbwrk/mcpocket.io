/**
 * `npm run demo:media` — creates a demo media pipeline on a RUNNING server,
 * entirely through the REST API (like real agents would):
 *
 *   Media Studio (demo)/
 *     1 · Prompts  →  2 · Images  →  3 · Videos  →  4 · Captions  →  5 · Publish
 *
 * Media is generated locally (PNG artwork, MP4 animated from the image as
 * first frame — needs `ffmpeg`, WAV voice-overs, PDF briefs), sent as data
 * URIs and uploaded to S3 by the server. Agents claim items and hand their
 * output to the next stage with `complete { next }`, so every stage has a
 * realistic mix of completed / pending / retry items with `metadata.source`
 * lineage. Needs media storage (MCPOCKET_S3_BUCKET) on the server.
 *
 * Env: MCPOCKET_URL (default http://localhost:3000), MCPOCKET_API_KEYS /
 * MCPOCKET_API_KEY_ROLES (an admin key creates the folder and tubes; an
 * agent or admin key runs the agents). `--force` creates another copy when
 * the demo folder already exists.
 *
 *   npx tsx --env-file=.env scripts/demo-media.ts
 */
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deflateSync } from "node:zlib"

const BASE_URL = (process.env.MCPOCKET_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  ""
)
const FOLDER_NAME = "Media Studio (demo)"
const FORCE = process.argv.includes("--force")

// ── API keys from the server's env ────────────────────────────────────────

function keysByRole() {
  const roles = new Map(
    (process.env.MCPOCKET_API_KEY_ROLES ?? "")
      .split(/[,\n]/)
      .map((p) => p.trim().split(":"))
      .filter((p) => p.length === 2)
      .map(([id, role]) => [id, role] as const)
  )
  const fallback = process.env.MCPOCKET_API_KEY_DEFAULT_ROLE?.trim() || "admin"
  const keys = (process.env.MCPOCKET_API_KEYS ?? "")
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(":")
      const id = pair.slice(0, i)
      return { id, secret: pair.slice(i + 1), role: roles.get(id) ?? fallback }
    })
  const admin = keys.find((k) => k.role === "admin")
  const agent =
    keys.find((k) => k.role === "agent") ??
    keys.find((k) => k.role === "operator") ??
    admin
  if (!admin || !agent) {
    throw new Error(
      "Need an admin API key in MCPOCKET_API_KEYS (see .env.example)"
    )
  }
  return { admin: admin.secret, agent: agent.secret }
}

const KEYS = keysByRole()

type Json = Record<string, unknown>

async function api<T = Json>(
  method: string,
  url: string,
  body?: unknown,
  opts: { agent?: string } = {}
): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${opts.agent ? KEYS.agent : KEYS.admin}`,
      ...(opts.agent && { "x-agent-id": opts.agent }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) {
    throw new Error(
      `${method} ${url} → ${res.status}: ${data?.error?.message ?? text}`
    )
  }
  return data as T
}

type Item = {
  id: string
  tubeId: string
  payload: Json
  metadata: Json
}

// ── Generated media ───────────────────────────────────────────────────────

const dataUri = (type: string, bytes: Buffer, name?: string) =>
  `data:${type}${name ? `;name=${encodeURIComponent(name)}` : ""};base64,${bytes.toString("base64")}`

function hash(text: string): number {
  let h = 2166136261
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [f(0), f(8), f(4)]
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A small "generated artwork": sky gradient, sun, hills — seeded by the prompt. */
function renderPng(prompt: string, size = 320): Buffer {
  const seed = hash(prompt)
  const hue = seed % 360
  const top = hsl(hue, 0.7, 0.25)
  const bottom = hsl((hue + 40) % 360, 0.8, 0.65)
  const sun = hsl((hue + 180) % 360, 0.9, 0.6)
  const hill = hsl((hue + 120) % 360, 0.45, 0.22)
  const sunX = size * (0.3 + ((seed >> 9) % 40) / 100)
  const sunY = size * 0.42
  const sunR = size * 0.11
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      const t = y / size
      let px = top.map((c, i) => Math.round(c + (bottom[i] - c) * t))
      if (Math.hypot(x - sunX, y - sunY) < sunR) px = sun
      const ridge =
        size * 0.68 +
        Math.sin(x / (size / 6) + (seed % 7)) * size * 0.05 +
        Math.sin(x / (size / 17)) * size * 0.015
      if (y > ridge)
        px = hill.map((c) => Math.round(c * (1 - (y - ridge) / size)))
      raw.set(px, row + 1 + x * 3)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

const FFMPEG = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

/** 3 s slow zoom from the first frame (H.264 MP4), or null without ffmpeg. */
async function renderMp4(firstFrame: Buffer): Promise<Buffer | null> {
  if (!FFMPEG) return null
  const dir = await mkdtemp(path.join(tmpdir(), "mcpocket-demo-"))
  try {
    const input = path.join(dir, "frame.png")
    const output = path.join(dir, "clip.mp4")
    await writeFile(input, firstFrame)
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        input,
        "-vf",
        "zoompan=z='min(zoom+0.006,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=48:s=320x320:fps=16,format=yuv420p",
        "-c:v",
        "libx264",
        "-movflags",
        "+faststart",
        output,
      ],
      { stdio: "ignore" }
    )
    return await readFile(output)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** ~2 s mono 16-bit WAV: a soft chord seeded by the caption. */
function renderWav(text: string, seconds = 2, rate = 22050): Buffer {
  const base = 196 + (hash(text) % 6) * 22
  const freqs = [base, base * 1.25, base * 1.5]
  const n = seconds * rate
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const env = Math.min(1, t * 8) * Math.min(1, (seconds - t) * 3)
    const v = freqs.reduce((s, f) => s + Math.sin(2 * Math.PI * f * t), 0) / 3
    data.writeInt16LE(Math.round(v * env * 0.4 * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** One-page PDF with a few lines of text (Helvetica). */
function renderPdf(lines: string[]): Buffer {
  const esc = (s: string) =>
    s.replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7e]/g, "-")
  const content =
    "BT /F1 18 Tf 56 760 Td (" +
    esc(lines[0]) +
    ") Tj /F1 11 Tf" +
    lines
      .slice(1)
      .map((l) => ` 0 -22 Td (${esc(l)}) Tj`)
      .join("") +
    " ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets
    .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
    .join("")
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, "latin1")
}

// ── Demo content ──────────────────────────────────────────────────────────

const PROMPTS = [
  { prompt: "A lighthouse at dusk over a calm violet sea", style: "cinematic" },
  {
    prompt: "Paper boats drifting through a neon city canal",
    style: "illustration",
  },
  { prompt: "A fox reading under a giant mushroom", style: "storybook" },
  {
    prompt: "Desert caravan crossing glowing dunes at night",
    style: "cinematic",
  },
  { prompt: "Floating islands with waterfalls into clouds", style: "fantasy" },
  { prompt: "Retro robot watering a rooftop garden", style: "pixel-soft" },
]

const STAGES = [
  {
    key: "prompts",
    name: "1 · Prompts",
    agent: null,
    task: "Ideas waiting for an image. Image agents: claim, generate an image from payload.prompt, then complete_item with next → 2 · Images { prompt, style, image } (image URL from ingest_media / create_media_upload, or a data URI).",
  },
  {
    key: "images",
    name: "2 · Images",
    agent: "imager",
    task: "Generated images. Video agents: claim, animate payload.image (first frame) into a short clip, then complete_item with next → 3 · Videos { prompt, firstFrame, video }. Video jobs are slow: this tube leases items for 30 min.",
    // Video generation runs while an Images item is claimed.
    leaseSeconds: 1800,
  },
  {
    key: "videos",
    name: "3 · Videos",
    agent: "animator",
    task: "Short clips. Caption agents: claim, write a caption and record a voice-over, then complete_item with next → 4 · Captions { video, caption, hashtags, voiceover }.",
  },
  {
    key: "captions",
    name: "4 · Captions",
    agent: "captioner",
    task: "Captioned clips. Publisher agents: claim, then complete_item with next → 5 · Publish { video, thumbnail, caption, channel }.",
  },
  {
    key: "publish",
    name: "5 · Publish",
    agent: "publisher",
    task: "Ready to post. Publishing agents: claim, post to the channel, then complete_item with result { postUrl }.",
  },
] as const

type StageKey = (typeof STAGES)[number]["key"]

// ── Run ───────────────────────────────────────────────────────────────────

async function claim(agent: string, tubeId: string): Promise<Item | null> {
  const res = await api<{ claimed: boolean; data: Item | null }>(
    "POST",
    "/api/items/claim",
    { tubeId },
    { agent }
  )
  return res.claimed ? res.data : null
}

async function complete(
  agent: string,
  itemId: string,
  body: { result?: unknown; next?: unknown }
): Promise<{ data: Item; next?: Item[] }> {
  return api("POST", `/api/items/${itemId}/complete`, body, { agent })
}

async function main() {
  const media = await api<{ data: { enabled: boolean } }>("GET", "/api/media")
  if (!media.data.enabled) {
    throw new Error(
      "Media storage is off on the server: set MCPOCKET_S3_BUCKET and restart it"
    )
  }
  const roots = await api<{ data: { id: string; name: string }[] }>(
    "GET",
    "/api/folders?parentId=root&limit=200"
  )
  if (!FORCE && roots.data.some((f) => f.name === FOLDER_NAME)) {
    throw new Error(
      `"${FOLDER_NAME}" already exists — delete it in the dashboard or run with --force`
    )
  }

  console.log(`Creating "${FOLDER_NAME}" on ${BASE_URL} …`)
  const folder = (
    await api<{ data: { id: string } }>("POST", "/api/folders", {
      name: FOLDER_NAME,
      description:
        "Demo media pipeline: prompts → images → videos → captions → publish. Items carry media as S3 URLs; open any tube's Media tab.",
    })
  ).data
  const tubes = {} as Record<StageKey, string>
  for (const stage of STAGES) {
    tubes[stage.key] = (
      await api<{ data: { id: string } }>("POST", "/api/tubes", {
        folderId: folder.id,
        name: stage.name,
        description: stage.task,
      })
    ).data.id
  }
  // Pipeline wiring: nextTubeIds lets agents bound to one tube
  // (/api/mcp/tubes/<id>) hand off to the next stage; the description also
  // names the id for agents reading it. Slow stages get a longer lease.
  for (const [i, stage] of STAGES.entries()) {
    const next = STAGES[i + 1]
    const patch = {
      ...(next && {
        description: `${stage.task} Next tube id: ${tubes[next.key]}.`,
        nextTubeIds: [tubes[next.key]],
      }),
      ...("leaseSeconds" in stage && { leaseSeconds: stage.leaseSeconds }),
    }
    if (Object.keys(patch).length === 0) continue
    await api("PATCH", `/api/tubes/${tubes[stage.key]}`, patch)
  }

  // Stage 1: prompts (each with a PDF creative brief in metadata).
  for (const [i, p] of PROMPTS.entries()) {
    await api("POST", `/api/tubes/${tubes.prompts}/items`, {
      payload: { prompt: p.prompt, style: p.style, aspect: "1:1" },
      metadata: {
        brief: dataUri(
          "application/pdf",
          renderPdf([
            `Creative brief #${i + 1}`,
            `Prompt: ${p.prompt}`,
            `Style: ${p.style}`,
            "Format: 1:1, 3 s loop, captions in English",
            "Owner: MCPocket demo",
          ]),
          `brief-${i + 1}.pdf`
        ),
      },
      tags: ["demo", p.style],
      priority: PROMPTS.length - i,
      idempotencyKey: `demo-prompt-${i + 1}-${Date.now()}`,
    })
  }

  // Stage 1 → 2: imager renders 5 of 6 prompts; one fails (retry later).
  const images: Item[] = []
  for (let i = 0; i < 5; i++) {
    const item = await claim("imager", tubes.prompts)
    if (!item) break
    const prompt = String(item.payload.prompt)
    if (i === 3) {
      await api(
        "POST",
        `/api/items/${item.id}/fail`,
        {
          error: {
            message: "Upstream image model timed out",
            code: "model_timeout",
          },
        },
        { agent: "imager" }
      )
      continue
    }
    const image = dataUri("image/png", renderPng(prompt), "image.png")
    const done = await complete("imager", item.id, {
      result: { model: "demo-imagegen-1", seed: hash(prompt) },
      next: {
        tubeId: tubes.images,
        payload: { prompt, style: item.payload.style, image },
        tags: ["demo"],
      },
    })
    images.push(...(done.next ?? []))
  }

  // Stage 2 → 3: animator turns 3 images into clips (first frame = image).
  for (let i = 0; i < 3; i++) {
    const item = await claim("animator", tubes.images)
    if (!item) break
    // Like a real agent: download the first frame from its media URL.
    const res = await fetch(String(item.payload.image))
    if (!res.ok) {
      throw new Error(
        `Cannot download ${item.payload.image} (${res.status}): is the bucket / MCPOCKET_S3_ACL public-read?`
      )
    }
    const clip = await renderMp4(Buffer.from(await res.arrayBuffer()))
    await complete("animator", item.id, {
      result: { model: "demo-img2video-1", seconds: 3 },
      next: {
        tubeId: tubes.videos,
        payload: {
          prompt: item.payload.prompt,
          firstFrame: item.payload.image,
          video: clip ? dataUri("video/mp4", clip, "clip.mp4") : null,
        },
        tags: ["demo"],
      },
    })
  }

  // Stage 3 → 4: captioner writes captions + voice-overs for 2 clips.
  for (let i = 0; i < 2; i++) {
    const item = await claim("captioner", tubes.videos)
    if (!item) break
    const caption = `${String(item.payload.prompt)} ✨`
    await complete("captioner", item.id, {
      result: { words: caption.split(" ").length },
      next: {
        tubeId: tubes.captions,
        payload: {
          video: item.payload.video,
          firstFrame: item.payload.firstFrame,
          caption,
          hashtags: ["#mcpocket", "#aiart", "#demo"],
          voiceover: dataUri("audio/wav", renderWav(caption), "voiceover.wav"),
        },
        tags: ["demo"],
      },
    })
  }

  // Stage 4 → 5: publisher prepares 1 post (waits in 5 · Publish).
  const ready = await claim("publisher", tubes.captions)
  if (ready) {
    await complete("publisher", ready.id, {
      result: { approved: true },
      next: {
        tubeId: tubes.publish,
        payload: {
          channel: "demo-channel",
          video: ready.payload.video,
          thumbnail: ready.payload.firstFrame,
          caption: ready.payload.caption,
          hashtags: ready.payload.hashtags,
        },
        tags: ["demo"],
      },
    })
  }

  console.log(
    [
      `Done${FFMPEG ? "" : " (ffmpeg not found: clips have video: null)"}.`,
      ...STAGES.map(
        (s) =>
          `  ${s.name.padEnd(13)} ${BASE_URL}/dashboard/tubes/${tubes[s.key]}`
      ),
      `  Media tab of a tube: …/dashboard/tubes/<id>/media · all media: ${BASE_URL}/dashboard/media`,
    ].join("\n")
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

"use client"

import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileAudioIcon,
  FileIcon,
  FileTextIcon,
  FileVideoIcon,
  ImageIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import * as React from "react"
import { toast } from "sonner"

import {
  deleteMediaAction,
  mediaUsageAction,
  uploadMediaAction,
} from "@/app/dashboard/media/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  mediaHref,
  MEDIA_PAGE_SIZE,
  type MediaQuery,
} from "@/lib/dashboard/media"
import type { ActionResult } from "@/lib/dashboard/explorer"
import { cn } from "@/lib/utils"
import {
  formatBytes,
  MEDIA_KIND_LABELS,
  MEDIA_KINDS,
  type MediaKind,
} from "@mcpocket/core/media/kinds"
import type {
  MediaEntry,
  MediaListResult,
  MediaUsage,
} from "@mcpocket/core/services/media"

import { ActionError } from "./action-error"
import { ItemStatusBadge } from "./item-status"
import { useServerAction } from "./use-server-action"
import { UtcTime } from "./utc-time"

const KIND_ICONS: Record<
  MediaKind,
  React.ComponentType<{ className?: string }>
> = {
  image: ImageIcon,
  video: FileVideoIcon,
  audio: FileAudioIcon,
  document: FileTextIcon,
  other: FileIcon,
}

/** Last path segment of a key, shortened: `ab12…ef.png`. */
function shortName(key: string): string {
  const name = key.split("/").pop() ?? key
  const dot = name.lastIndexOf(".")
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ""
  return base.length > 12 ? `${base.slice(0, 6)}…${base.slice(-4)}${ext}` : name
}

export function MediaLibrary({
  result,
  query,
  tubeId,
}: {
  result: MediaListResult
  query: MediaQuery
  /**
   * Tube Media tab: files that tube's items reference. No upload (files are
   * not tied to tubes) and no "unused" filter (every file shown is used).
   */
  tubeId?: string
}) {
  const [selected, setSelected] = React.useState<Selection | null>(null)
  const { summary, page } = result
  const pages = Math.max(1, Math.ceil(page.total / MEDIA_PAGE_SIZE))
  const basePath = tubeId ? `/dashboard/tubes/${tubeId}/media` : undefined
  const href = (changes: Partial<MediaQuery>) =>
    mediaHref(query, changes, basePath)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-px border bg-border sm:grid-cols-4">
        <Stat label="Files" value={summary.count.toLocaleString()} />
        <Stat label="Total size" value={formatBytes(summary.bytes)} />
        <Stat
          label="Images · Videos"
          value={`${summary.byKind.image.count} · ${summary.byKind.video.count}`}
        />
        {tubeId ? (
          <Stat
            label="Documents · Other"
            value={`${summary.byKind.document.count} · ${summary.byKind.other.count + summary.byKind.audio.count}`}
          />
        ) : (
          <Stat
            label="Not used by any item"
            value={summary.unused.toLocaleString()}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterLink
          href={href({ kind: null })}
          active={!query.kind}
          label="All"
          count={summary.count}
        />
        {MEDIA_KINDS.map((kind) => (
          <FilterLink
            key={kind}
            href={href({ kind })}
            active={query.kind === kind}
            label={MEDIA_KIND_LABELS[kind]}
            count={summary.byKind[kind].count}
          />
        ))}
        {!tubeId && (
          <>
            <span className="mx-1 h-4 w-px bg-border" />
            <FilterLink
              href={href({
                usage: query.usage === "unused" ? null : "unused",
              })}
              active={query.usage === "unused"}
              label="Unused only"
              count={summary.unused}
            />
            <div className="ml-auto">
              <UploadButton />
            </div>
          </>
        )}
      </div>

      {result.data.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ImageIcon />
            </EmptyMedia>
            <EmptyTitle>
              {summary.count === 0
                ? tubeId
                  ? "No media in this tube"
                  : "No media yet"
                : "Nothing matches"}
            </EmptyTitle>
            <EmptyDescription>
              {summary.count > 0
                ? "Try another filter."
                : tubeId
                  ? "No item in this tube references a stored file yet. Push or complete items with data URIs (data:image/png;base64,…) and they show up here."
                  : "Upload files here, or push items with data URIs (data:image/png;base64,…) — they are stored here automatically."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {result.data.map((entry) => (
            <li key={entry.key}>
              <MediaCard
                entry={entry}
                onOpen={() =>
                  setSelected({ entry, usage: mediaUsageAction(entry.key) })
                }
              />
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {page.offset + 1}–{page.offset + result.data.length} of{" "}
            {page.total.toLocaleString()}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={query.page <= 1}
              render={
                query.page > 1 ? (
                  <Link href={href({ page: query.page - 1 })} />
                ) : undefined
              }
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={query.page >= pages}
              render={
                query.page < pages ? (
                  <Link href={href({ page: query.page + 1 })} />
                ) : undefined
              }
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <MediaDetails selection={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 bg-card p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-semibold tabular-nums">{value}</span>
    </div>
  )
}

function FilterLink({
  href,
  active,
  label,
  count,
}: {
  href: string
  active: boolean
  label: string
  count: number
}) {
  return (
    <Button
      size="sm"
      variant={active ? "secondary" : "ghost"}
      render={<Link href={href} scroll={false} />}
    >
      {label}
      <span className="text-muted-foreground tabular-nums">{count}</span>
    </Button>
  )
}

function Preview({
  entry,
  controls = false,
  className,
}: {
  entry: MediaEntry
  controls?: boolean
  className?: string
}) {
  const Icon = KIND_ICONS[entry.kind]
  if (entry.kind === "image") {
    return (
      // Bucket URLs are arbitrary hosts: a plain <img> avoids next/image config.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={entry.url}
        alt=""
        loading="lazy"
        className={cn("size-full object-contain", className)}
      />
    )
  }
  if (entry.kind === "video") {
    return (
      <video
        src={controls ? entry.url : `${entry.url}#t=0.1`}
        controls={controls}
        muted={!controls}
        preload="metadata"
        playsInline
        className={cn("size-full object-contain", className)}
      />
    )
  }
  if (entry.kind === "audio" && controls) {
    return <audio src={entry.url} controls className="w-full" />
  }
  return (
    <div className="flex size-full items-center justify-center text-muted-foreground">
      <Icon className="size-8" />
    </div>
  )
}

function MediaCard({
  entry,
  onOpen,
}: {
  entry: MediaEntry
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col border bg-card text-left transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="pointer-events-none aspect-square overflow-hidden bg-muted">
        <Preview entry={entry} />
      </div>
      <div className="flex flex-col gap-1 p-2 text-xs">
        <span className="truncate font-mono" title={entry.key}>
          {shortName(entry.key)}
        </span>
        <span className="flex items-center justify-between gap-1 text-muted-foreground">
          <span>{formatBytes(entry.size)}</span>
          {entry.usedBy > 0 ? (
            <span>
              {entry.usedBy} item{entry.usedBy === 1 ? "" : "s"}
            </span>
          ) : (
            <Badge variant="outline" className="text-[10px]">
              unused
            </Badge>
          )}
        </span>
      </div>
    </button>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {label}
    </Button>
  )
}

type Selection = {
  entry: MediaEntry
  /** Started on click, read with `React.use` (no effect, no stale results). */
  usage: Promise<ActionResult<MediaUsage>>
}

function MediaDetails({
  selection,
  onClose,
}: {
  selection: Selection | null
  onClose: () => void
}) {
  return (
    <Dialog
      open={selection !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent className="sm:max-w-3xl">
        {selection && (
          // Remount per file so confirm / error state starts fresh.
          <MediaDetailsBody
            key={selection.entry.key}
            entry={selection.entry}
            usage={selection.usage}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MediaDetailsBody({
  entry,
  usage,
  onClose,
}: Selection & { onClose: () => void }) {
  const router = useRouter()
  const [confirming, setConfirming] = React.useState(false)
  const { pending, error, run } = useServerAction()

  function remove() {
    run(
      () => deleteMediaAction(entry.key),
      () => {
        toast.success("File deleted")
        onClose()
        router.refresh()
      }
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="truncate font-mono text-sm">
          {entry.key.split("/").pop()}
        </DialogTitle>
        <DialogDescription>
          {entry.contentType} · {formatBytes(entry.size)} · uploaded{" "}
          <UtcTime iso={entry.lastModified} />
        </DialogDescription>
      </DialogHeader>

      <div className="flex max-h-[50vh] min-h-40 items-center justify-center overflow-hidden bg-muted">
        <Preview entry={entry} controls className="max-h-[50vh]" />
      </div>

      <div className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">URL</span>
        <code className="font-mono break-all">{entry.url}</code>
      </div>

      <div className="flex flex-col gap-2 text-xs">
        <span className="text-muted-foreground">Used by</span>
        <React.Suspense fallback={<span>Looking for items…</span>}>
          <UsageList usage={usage} onNavigate={onClose} />
        </React.Suspense>
      </div>

      <ActionError error={error} />
      {confirming && (
        <p className="border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
          Delete this file from the bucket?{" "}
          <React.Suspense fallback={null}>
            <UsageWarning usage={usage} />
          </React.Suspense>{" "}
          This cannot be undone.
        </p>
      )}

      <DialogFooter className="sm:justify-between">
        <div className="flex gap-2">
          <CopyButton value={entry.url} label="Copy URL" />
          <Button
            size="sm"
            variant="outline"
            render={<a href={entry.url} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon />
            Open
          </Button>
        </div>
        {confirming ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={remove}
            >
              {pending ? "Deleting…" : "Delete file"}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirming(true)}
          >
            <Trash2Icon />
            Delete
          </Button>
        )}
      </DialogFooter>
    </>
  )
}

function UsageList({
  usage,
  onNavigate,
}: {
  usage: Selection["usage"]
  onNavigate: () => void
}) {
  const result = React.use(usage)
  if (!result.ok) return <ActionError error={result.error} />
  const { items } = result.data
  if (items.length === 0) return <span>No item references this file.</span>
  return (
    <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-2">
          <ItemStatusBadge status={item.status} />
          <Link
            href={`/dashboard/tubes/${item.tubeId}?item=${item.id}`}
            className="truncate underline-offset-2 hover:underline"
            onClick={onNavigate}
          >
            {item.tubeName} /{" "}
            <span className="font-mono">{item.id.slice(0, 8)}</span>
          </Link>
          <span className="text-muted-foreground">
            {item.fields.join(", ")}
          </span>
        </li>
      ))}
    </ul>
  )
}

function UsageWarning({ usage }: { usage: Selection["usage"] }) {
  const result = React.use(usage)
  const users = result.ok ? result.data.items.length : 0
  return users > 0
    ? `${users} item${users === 1 ? "" : "s"} still link to it and will show a broken link.`
    : "No item uses it."
}

/** Uploads the chosen files one by one (one request each), then refreshes. */
function UploadButton() {
  const router = useRouter()
  const input = React.useRef<HTMLInputElement>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  async function upload(files: FileList) {
    const list = [...files]
    let ok = 0
    for (const [i, file] of list.entries()) {
      setBusy(`${i + 1}/${list.length}`)
      const form = new FormData()
      form.set("file", file)
      try {
        const result = await uploadMediaAction(form)
        if (result.ok) ok++
        else toast.error(`${file.name}: ${result.error.message}`)
      } catch (error) {
        toast.error(
          `${file.name}: ${error instanceof Error ? error.message : "Upload failed"}`
        )
      }
    }
    setBusy(null)
    if (ok > 0) {
      toast.success(`Uploaded ${ok} file${ok === 1 ? "" : "s"}`)
      router.refresh()
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void upload(e.target.files)
          e.target.value = ""
        }}
      />
      <Button
        size="sm"
        disabled={busy !== null}
        onClick={() => input.current?.click()}
      >
        <UploadIcon />
        {busy ? `Uploading ${busy}…` : "Upload"}
      </Button>
    </>
  )
}

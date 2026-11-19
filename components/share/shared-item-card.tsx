"use client"

import {
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  Loader2Icon,
  Share2Icon,
} from "lucide-react"
import * as React from "react"

import { CopyButton } from "@/components/dashboard/copy-block"
import { ItemStatusBadge } from "@/components/dashboard/item-status"
import { JsonView } from "@/components/dashboard/json-editor"
import { UtcTime } from "@/components/dashboard/utc-time"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { SharedItem, SharedMedia } from "@/lib/share/types"
import { cn } from "@/lib/utils"

/** One item of a shared tube: its media (playable) then every field. */
export function SharedItemCard({ item }: { item: SharedItem }) {
  const hasMetadata = Object.keys(item.metadata).length > 0
  return (
    <article
      className="flex flex-col gap-3 border bg-card p-3"
      data-item-id={item.id}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <ItemStatusBadge status={item.status} />
        <span className="text-muted-foreground">
          <UtcTime iso={item.createdAt} /> UTC
        </span>
        {item.tags.map((tag) => (
          <Badge key={tag} variant="secondary">
            {tag}
          </Badge>
        ))}
        <span className="ml-auto flex items-center gap-0.5 font-mono text-[0.65rem] text-muted-foreground">
          {item.id.slice(0, 8)}
          <CopyButton value={item.id} label="Copy item id" />
        </span>
      </header>

      {item.media.length > 0 && (
        <div
          className={cn(
            "grid gap-3",
            item.media.length > 1 && "sm:grid-cols-2"
          )}
        >
          {item.media.map((media) => (
            <MediaTile key={media.url} media={media} />
          ))}
        </div>
      )}

      {item.result !== undefined && (
        <Fields title="Result" value={item.result} />
      )}
      <Fields title="Payload" value={item.payload} />
      {hasMetadata && <Fields title="Metadata" value={item.metadata} />}

      {item.error && (
        <p className="border border-destructive/30 bg-destructive/5 p-2 text-xs">
          <span className="font-medium text-destructive">Last error</span>{" "}
          {item.error}
        </p>
      )}
    </article>
  )
}

const fileName = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "file")
  } catch {
    return "file"
  }
}

function MediaTile({ media }: { media: SharedMedia }) {
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-center overflow-hidden border bg-muted/40">
        {media.kind === "image" ? (
          // Media hosts are arbitrary: a plain <img> avoids next/image config.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={media.url}
            alt={media.path}
            loading="lazy"
            className="max-h-[32rem] w-full object-contain"
          />
        ) : media.kind === "video" ? (
          <video
            src={media.url}
            controls
            playsInline
            preload="metadata"
            className="max-h-[32rem] w-full bg-black"
          />
        ) : media.kind === "audio" ? (
          <audio src={media.url} controls className="w-full p-2" />
        ) : (
          <a
            href={media.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full items-center gap-2 p-3 text-xs hover:underline"
          >
            <FileIcon className="size-4 shrink-0" />
            <span className="truncate">{fileName(media.url)}</span>
          </a>
        )}
      </div>
      <figcaption className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[0.65rem] text-muted-foreground">
          {media.path}
        </span>
        <ShareMediaButton url={media.url} />
        <Button
          variant="ghost"
          size="icon-xs"
          title="Download"
          aria-label="Download"
          nativeButton={false}
          render={<a href={media.url} download={fileName(media.url)} />}
        >
          <DownloadIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          title="Open in a new tab"
          aria-label="Open in a new tab"
          nativeButton={false}
          render={
            <a href={media.url} target="_blank" rel="noopener noreferrer" />
          }
        >
          <ExternalLinkIcon />
        </Button>
        <CopyButton value={media.url} label="Copy link" />
      </figcaption>
    </figure>
  )
}

const subscribeNoop = () => () => {}

/**
 * Native share sheet (phones): sends the file itself when the browser can
 * share files (post straight to a social app), otherwise the link. Hidden
 * where the Web Share API is missing.
 */
function ShareMediaButton({ url }: { url: string }) {
  const canShare = React.useSyncExternalStore(
    subscribeNoop,
    () => typeof navigator.share === "function",
    () => false
  )
  const [busy, setBusy] = React.useState(false)
  if (!canShare) return null

  async function share() {
    setBusy(true)
    try {
      const blob = await fetch(url).then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.blob()
      })
      const file = new File([blob], fileName(url), { type: blob.type })
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] })
      } else {
        await navigator.share({ url })
      }
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return
      await navigator.share({ url }).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title="Share"
      aria-label="Share"
      disabled={busy}
      onClick={() => void share()}
    >
      {busy ? <Loader2Icon className="animate-spin" /> : <Share2Icon />}
    </Button>
  )
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

/** A field group (payload / result / metadata): one row per top-level key. */
function Fields({ title, value }: { title: string; value: unknown }) {
  const entries = isPlainObject(value) ? Object.entries(value) : null
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between border-b pb-1">
        <h3 className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        <CopyButton
          value={JSON.stringify(value, null, 2)}
          label={`Copy ${title.toLowerCase()} JSON`}
        />
      </div>
      {entries === null ? (
        <FieldValue value={value} />
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">Empty</p>
      ) : (
        <dl className="flex flex-col gap-2">
          {entries.map(([key, v]) => (
            <div
              key={key}
              className="grid min-w-0 gap-1 sm:grid-cols-[10rem_1fr] sm:gap-3"
            >
              <dt className="truncate font-mono text-[0.7rem] text-muted-foreground sm:pt-0.5">
                {key}
              </dt>
              <dd className="min-w-0">
                <FieldValue value={v} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

const HTTP_URL = /^https?:\/\/\S+$/i

function FieldValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    const isUrl = HTTP_URL.test(value)
    return (
      <div className="group flex items-start gap-1">
        {isUrl ? (
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 text-xs break-all text-primary underline-offset-2 hover:underline"
          >
            {value}
          </a>
        ) : (
          <p className="min-w-0 flex-1 text-sm break-words whitespace-pre-wrap">
            {value}
          </p>
        )}
        <CopyButton value={value} label="Copy" className="shrink-0" />
      </div>
    )
  }
  if (value === null || typeof value !== "object") {
    return (
      <span className="font-mono text-xs">
        {value === undefined ? "—" : String(value)}
      </span>
    )
  }
  return <JsonView value={value} className="max-h-80" />
}

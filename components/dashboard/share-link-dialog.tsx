"use client"

import { ExternalLinkIcon, KeyRoundIcon, Loader2Icon } from "lucide-react"
import Link from "next/link"
import * as React from "react"
import { toast } from "sonner"

import {
  createShareKeyAction,
  shareKeyOptionsAction,
  shareLinkAction,
} from "@/app/dashboard/share/actions"
import { Button } from "@/components/ui/button"
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type {
  ShareKeyOption,
  ShareLink,
  ShareTarget,
} from "@/lib/dashboard/share"

import { ActionError } from "./action-error"
import { CopyButton } from "./copy-block"
import { useServerAction } from "./use-server-action"

/**
 * Body of the share dialog: pick a key (or create a read-only one scoped to
 * the target), then copy / open / scan the public link.
 */
export function ShareLinkDialogBody({ target }: { target: ShareTarget }) {
  const [keys, setKeys] = React.useState<ShareKeyOption[] | null>(null)
  const [keyId, setKeyId] = React.useState("")
  const [link, setLink] = React.useState<ShareLink | null>(null)
  const { pending, error, run } = useServerAction()

  // Load eligible keys once; preselect the first and build its link.
  React.useEffect(() => {
    run(
      () => shareKeyOptionsAction(target),
      (options) => {
        setKeys(options)
        if (options[0]) {
          setKeyId(options[0].id)
          run(() => shareLinkAction(target, options[0].id), setLink)
        }
      }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.kind, target.id])

  function selectKey(id: string) {
    setKeyId(id)
    setLink(null)
    if (id) run(() => shareLinkAction(target, id), setLink)
  }

  function createKey() {
    run(
      () => createShareKeyAction(target),
      (created) => {
        setKeys((prev) => [
          {
            id: created.keyId,
            description: null,
            role: "readonly",
            roleLabel: "Read-only",
            scoped: true,
          },
          ...(prev ?? []),
        ])
        setKeyId(created.keyId)
        setLink(created)
        toast.success(`Created read-only key “${created.keyId}”`)
      }
    )
  }

  const noun = target.kind === "tube" ? "tube" : "folder"

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Share “{target.name}”</DialogTitle>
        <DialogDescription>
          Anyone with this link can browse the {noun}&apos;s items, fields and
          media, no sign-in needed. The link carries an API key: use a read-only
          key and revoke it on the{" "}
          <Link href="/dashboard/access" className="underline">
            Access
          </Link>{" "}
          page to turn the link off.
        </DialogDescription>
      </DialogHeader>

      {keys === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" /> Loading keys…
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {keys.length > 0 && (
            <NativeSelect
              aria-label="API key"
              className="w-full"
              value={keyId}
              disabled={pending}
              onChange={(e) => selectKey(e.target.value)}
            >
              {keys.map((k) => (
                <NativeSelectOption key={k.id} value={k.id}>
                  {k.id} · {k.roleLabel}
                  {k.scoped ? "" : " · all tubes"}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          {keys.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No key can be used yet: a link needs an active key created with
              “show each time” that can read this {noun}.
            </p>
          )}
          <Button
            size="sm"
            variant={keys.length === 0 ? "default" : "outline"}
            className="self-start"
            disabled={pending}
            onClick={createKey}
          >
            <KeyRoundIcon data-icon="inline-start" />
            Create a read-only key for this {noun}
          </Button>
        </div>
      )}

      <ActionError error={error} />

      {link && (
        <div className="flex flex-col items-center gap-3 border-t pt-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={link.qr}
            alt="QR code of the share link"
            className="size-48 bg-white p-1"
          />
          <div className="flex w-full items-center gap-1">
            <Input
              readOnly
              value={link.url}
              aria-label="Share link"
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton value={link.url} label="Copy link" />
            <Button
              variant="ghost"
              size="icon-xs"
              title="Open link"
              aria-label="Open link"
              nativeButton={false}
              render={
                <a href={link.url} target="_blank" rel="noopener noreferrer" />
              }
            >
              <ExternalLinkIcon />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

"use client"

import { Share2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ShareTarget } from "@/lib/dashboard/share"

import { useExplorer } from "./explorer-dialogs"

/** Tube header "Share" button: opens the share dialog of the explorer. */
export function ShareLinkButton({ target }: { target: ShareTarget }) {
  const { openDialog } = useExplorer()
  return (
    <Button
      size="sm"
      variant="outline"
      title="Public link to browse this tube's items and media"
      onClick={() => openDialog({ kind: "share", target })}
    >
      <Share2Icon data-icon="inline-start" />
      Share
    </Button>
  )
}

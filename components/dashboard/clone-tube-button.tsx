"use client"

import { CopyIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ExplorerTube } from "@/lib/dashboard/explorer"

import { useExplorer } from "./explorer-dialogs"

/** Tube header "Clone" button: opens the same dialog as the sidebar menu. */
export function CloneTubeButton({ tube }: { tube: ExplorerTube }) {
  const { openDialog } = useExplorer()
  return (
    <Button
      size="sm"
      variant="outline"
      title="Create a copy of this tube"
      onClick={() => openDialog({ kind: "cloneTube", tube })}
    >
      <CopyIcon />
      Clone
    </Button>
  )
}

"use client"

import { PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

import { useExplorer } from "./explorer-dialogs"

/** Opens the "New tube" dialog (top level by default). */
export function NewTubeButton() {
  const { openDialog } = useExplorer()
  return (
    <Button onClick={() => openDialog({ kind: "createTube", folderId: null })}>
      <PlusIcon /> New tube
    </Button>
  )
}

"use client"

import {
  BrainIcon,
  CheckIcon,
  PencilIcon,
  PlusIcon,
  ScrollTextIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import {
  addTubeMemoryAction,
  deleteTubeMemoryAction,
  updateTubeInstructionsAction,
  updateTubeMemoryAction,
} from "@/app/dashboard/actions"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import type { TubeMemoryBlock } from "@mcpocket/core/domain/schemas"

import { ActionError } from "./action-error"
import { UtcTime } from "./utc-time"
import { useServerAction } from "./use-server-action"

type Limits = { instructions: number; blocks: number; text: number }

/**
 * Instructions + memory of a tube. Values come from the server component
 * (refreshed by live updates); local drafts are kept only while dirty, so an
 * agent adding memory never wipes what the user is typing.
 */
export function TubeContextEditor({
  tubeId,
  instructions,
  memory,
  limits,
}: {
  tubeId: string
  instructions: string
  memory: TubeMemoryBlock[]
  limits: Limits
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <InstructionsCard
        tubeId={tubeId}
        instructions={instructions}
        max={limits.instructions}
      />
      <MemoryCard tubeId={tubeId} memory={memory} limits={limits} />
    </div>
  )
}

/** Draft that follows `value` from the server until the user edits it. */
function useDraft(value: string) {
  const [base, setBase] = React.useState(value)
  const [draft, setDraft] = React.useState(value)
  if (value !== base) {
    setBase(value)
    if (draft === base) setDraft(value)
  }
  return { draft, setDraft, dirty: draft !== value }
}

function InstructionsCard({
  tubeId,
  instructions,
  max,
}: {
  tubeId: string
  instructions: string
  max: number
}) {
  const { draft, setDraft, dirty } = useDraft(instructions)
  const { pending, error, run } = useServerAction()

  function save() {
    run(
      () => updateTubeInstructionsAction(tubeId, draft),
      () => toast.success(draft.trim() ? "Instructions saved" : "Cleared")
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <ScrollTextIcon className="size-3.5" />
          Instructions
        </CardTitle>
        <CardDescription>
          How agents should work this tube, like a skill (Markdown). Agents get
          them with <code>get_tube_context</code>, and MCP connections bound to
          this tube receive them up front.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Textarea
          aria-label="Instructions"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={max}
          placeholder={
            "# Goal\nWhat this stage produces…\n\n# Steps\n1. …\n\n# Rules\n- …"
          }
          className="min-h-72 font-mono"
          disabled={pending}
        />
        <ActionError error={error} />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {draft.length.toLocaleString()} / {max.toLocaleString()}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDraft(instructions)}
              disabled={!dirty || pending}
            >
              Discard
            </Button>
            <Button size="sm" onClick={save} disabled={!dirty || pending}>
              <CheckIcon data-icon="inline-start" />
              Save
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function MemoryCard({
  tubeId,
  memory,
  limits,
}: {
  tubeId: string
  memory: TubeMemoryBlock[]
  limits: Limits
}) {
  const [text, setText] = React.useState("")
  const { pending, error, run } = useServerAction()
  const full = memory.length >= limits.blocks

  function add() {
    run(
      () => addTubeMemoryAction(tubeId, text),
      () => {
        setText("")
        toast.success("Memory added")
      }
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <BrainIcon className="size-3.5" />
          Memory
        </CardTitle>
        <CardDescription>
          Notes kept by agents (<code>add_tube_memory</code>) and users:
          lessons, conventions, pitfalls. Oldest first.
        </CardDescription>
        <CardAction>
          <span className="text-xs text-muted-foreground tabular-nums">
            {memory.length} / {limits.blocks}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {memory.length === 0 ? (
          <p className="border border-dashed p-3 text-xs text-muted-foreground">
            No memory yet.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {memory.map((block) => (
              <MemoryBlockRow
                key={block.id}
                tubeId={tubeId}
                block={block}
                max={limits.text}
              />
            ))}
          </ol>
        )}

        <div className="flex flex-col gap-2 border-t pt-3">
          <Textarea
            aria-label="New memory block"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={limits.text}
            placeholder="Add a note for the next agent…"
            disabled={pending || full}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim())
                add()
            }}
          />
          <ActionError error={error} />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={add}
              disabled={pending || full || !text.trim()}
            >
              <PlusIcon data-icon="inline-start" />
              Add memory
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function MemoryBlockRow({
  tubeId,
  block,
  max,
}: {
  tubeId: string
  block: TubeMemoryBlock
  max: number
}) {
  const [editing, setEditing] = React.useState(false)
  const [text, setText] = React.useState(block.text)
  const { pending, error, run } = useServerAction()

  function save() {
    run(
      () => updateTubeMemoryAction(tubeId, block.id, text),
      () => setEditing(false)
    )
  }

  function remove() {
    run(
      () => deleteTubeMemoryAction(tubeId, block.id),
      () => toast.success("Memory deleted")
    )
  }

  return (
    <li className="group flex flex-col gap-1.5 border p-2.5">
      {editing ? (
        <Textarea
          aria-label="Memory text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={max}
          disabled={pending}
          autoFocus
        />
      ) : (
        <p className="text-xs break-words whitespace-pre-wrap">{block.text}</p>
      )}
      <ActionError error={error} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          <UtcTime iso={block.updatedAt} />
          {block.updatedAt !== block.createdAt && " (edited)"}
        </span>
        <div className="flex gap-1">
          {editing ? (
            <>
              <Button
                size="icon-xs"
                variant="ghost"
                title="Cancel"
                onClick={() => {
                  setText(block.text)
                  setEditing(false)
                }}
                disabled={pending}
              >
                <XIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                title="Save"
                onClick={save}
                disabled={pending || !text.trim() || text === block.text}
              >
                <CheckIcon />
              </Button>
            </>
          ) : (
            <>
              <Button
                size="icon-xs"
                variant="ghost"
                title="Edit"
                onClick={() => {
                  setText(block.text)
                  setEditing(true)
                }}
                disabled={pending}
              >
                <PencilIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                title="Delete"
                onClick={remove}
                disabled={pending}
              >
                <Trash2Icon />
              </Button>
            </>
          )}
        </div>
      </div>
    </li>
  )
}

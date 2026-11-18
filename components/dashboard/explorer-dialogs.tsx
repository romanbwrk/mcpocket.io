"use client"

import { usePathname, useRouter } from "next/navigation"
import * as React from "react"
import { toast } from "sonner"

import {
  cloneTubeAction,
  createFolderAction,
  createTubeAction,
  deleteFolderAction,
  deleteTubeAction,
  moveFolderAction,
  moveTubeAction,
  updateFolderAction,
} from "@/app/dashboard/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  flattenFolders,
  type ExplorerFolder,
  type ExplorerTube,
} from "@/lib/dashboard/explorer"

import { ActionError } from "./action-error"
import { useExpandedFolders } from "./expanded-store"
import { useServerAction } from "./use-server-action"

export type ExplorerDialog =
  | { kind: "createFolder"; parentId: string | null }
  | { kind: "renameFolder"; folder: ExplorerFolder }
  | { kind: "moveFolder"; folder: ExplorerFolder }
  | { kind: "deleteFolder"; folder: ExplorerFolder }
  /** `folderId` preselects the folder; `null` = top level (no folder). */
  | { kind: "createTube"; folderId: string | null }
  | { kind: "moveTube"; tube: ExplorerTube }
  | { kind: "cloneTube"; tube: ExplorerTube }
  | { kind: "deleteTube"; tube: ExplorerTube }

type ExplorerContextValue = {
  tree: ExplorerFolder[]
  /** Top-level tubes (no folder). */
  rootTubes: ExplorerTube[]
  openDialog: (dialog: ExplorerDialog) => void
}

const ExplorerContext = React.createContext<ExplorerContextValue | null>(null)

export function useExplorer() {
  const ctx = React.useContext(ExplorerContext)
  if (!ctx) throw new Error("useExplorer must be used within ExplorerProvider")
  return ctx
}

/** Holds the folder tree and the currently open explorer dialog. */
export function ExplorerProvider({
  tree,
  rootTubes,
  children,
}: {
  tree: ExplorerFolder[]
  rootTubes: ExplorerTube[]
  children: React.ReactNode
}) {
  const [dialog, setDialog] = React.useState<ExplorerDialog | null>(null)
  const value = React.useMemo(
    () => ({ tree, rootTubes, openDialog: setDialog }),
    [tree, rootTubes]
  )
  return (
    <ExplorerContext.Provider value={value}>
      {children}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          {dialog && (
            <DialogBody
              // remount per dialog so form state resets
              key={dialogKey(dialog)}
              dialog={dialog}
              tree={tree}
              close={() => setDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </ExplorerContext.Provider>
  )
}

function dialogKey(d: ExplorerDialog): string {
  switch (d.kind) {
    case "createFolder":
      return `${d.kind}:${d.parentId}`
    case "createTube":
      return `${d.kind}:${d.folderId}`
    case "renameFolder":
    case "moveFolder":
    case "deleteFolder":
      return `${d.kind}:${d.folder.id}`
    default:
      return `${d.kind}:${d.tube.id}`
  }
}

type BodyProps = {
  dialog: ExplorerDialog
  tree: ExplorerFolder[]
  close: () => void
}

function DialogBody(props: BodyProps) {
  switch (props.dialog.kind) {
    case "createFolder":
    case "renameFolder":
      return <FolderForm {...props} />
    case "moveFolder":
    case "moveTube":
      return <MoveForm {...props} />
    case "deleteFolder":
    case "deleteTube":
      return <DeleteConfirm {...props} />
    case "createTube":
      return <CreateTubeForm {...props} />
    case "cloneTube":
      return <CloneTubeForm {...props} />
  }
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "")

function Footer({ pending, label }: { pending: boolean; label: string }) {
  return (
    <DialogFooter>
      <DialogClose render={<Button type="button" variant="outline" />}>
        Cancel
      </DialogClose>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : label}
      </Button>
    </DialogFooter>
  )
}

function folderPath(tree: ExplorerFolder[], id: string | null): string {
  if (!id) return "the top level"
  return flattenFolders(tree).find((f) => f.id === id)?.path ?? "unknown folder"
}

function FolderForm({ dialog, tree, close }: BodyProps) {
  const { pending, error, run } = useServerAction()
  const { expand } = useExpandedFolders()
  const editing = dialog.kind === "renameFolder" ? dialog.folder : null
  const parentId = dialog.kind === "createFolder" ? dialog.parentId : null

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = field(form, "name")
    const description = field(form, "description").trim()
    if (editing) {
      run(
        () =>
          updateFolderAction(editing.id, {
            name,
            description:
              description || (editing.description ? null : undefined),
          }),
        (folder) => {
          toast.success(`Folder renamed to “${folder.name}”`)
          close()
        }
      )
    } else {
      run(
        () =>
          createFolderAction({
            name,
            parentId,
            ...(description && { description }),
          }),
        (folder) => {
          if (parentId) expand([parentId])
          toast.success(`Folder “${folder.name}” created`)
          close()
        }
      )
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>
          {editing
            ? "Rename folder"
            : parentId
              ? "New subfolder"
              : "New folder"}
        </DialogTitle>
        <DialogDescription>
          {editing
            ? `Folder “${editing.name}”`
            : `Inside ${folderPath(tree, parentId)}`}
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="folder-name">Name</FieldLabel>
          <Input
            id="folder-name"
            name="name"
            autoFocus
            defaultValue={editing?.name}
            placeholder="e.g. Inbound"
            maxLength={200}
            aria-invalid={error?.code === "validation_error" || undefined}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="folder-description">Description</FieldLabel>
          <Textarea
            id="folder-description"
            name="description"
            defaultValue={editing?.description}
            placeholder="Optional"
            maxLength={2000}
            rows={3}
          />
        </Field>
      </FieldGroup>
      <ActionError error={error} />
      <Footer pending={pending} label={editing ? "Save" : "Create folder"} />
    </form>
  )
}

function CreateTubeForm({ dialog, tree, close }: BodyProps) {
  const { pending, error, run } = useServerAction()
  const { expand } = useExpandedFolders()
  const router = useRouter()
  const [enabled, setEnabled] = React.useState(true)
  const initialFolderId = dialog.kind === "createTube" ? dialog.folderId : null
  const options = flattenFolders(tree)

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const description = field(form, "description").trim()
    const target = field(form, "folder")
    const folderId = target && target !== ROOT ? target : null
    run(
      () =>
        createTubeAction({
          folderId,
          name: field(form, "name"),
          enabled,
          ...(description && { description }),
        }),
      (tube) => {
        if (folderId) expand([folderId])
        toast.success(`Tube “${tube.name}” created`)
        close()
        router.push(`/dashboard/tubes/${tube.id}`)
      }
    )
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>New tube</DialogTitle>
        <DialogDescription>
          A tube is a queue of items that agents can claim.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        {options.length > 0 && (
          <Field>
            <FieldLabel htmlFor="tube-folder">Folder</FieldLabel>
            <NativeSelect
              id="tube-folder"
              name="folder"
              className="w-full"
              defaultValue={initialFolderId ?? ROOT}
            >
              <NativeSelectOption value={ROOT}>
                None (top level)
              </NativeSelectOption>
              {options.map((o) => (
                <NativeSelectOption key={o.id} value={o.id}>
                  {`${"  ".repeat(o.depth)}${o.name}`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="tube-name">Name</FieldLabel>
          <Input
            id="tube-name"
            name="name"
            autoFocus
            placeholder="e.g. Leads"
            maxLength={200}
            aria-invalid={error?.code === "validation_error" || undefined}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="tube-description">Description</FieldLabel>
          <Textarea
            id="tube-description"
            name="description"
            placeholder="Optional"
            maxLength={2000}
            rows={3}
          />
        </Field>
        <Field orientation="horizontal">
          <Switch
            id="tube-enabled"
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked)}
          />
          <FieldLabel htmlFor="tube-enabled">
            Enabled
            <FieldDescription className="sr-only">
              Disabled tubes reject new items and claims
            </FieldDescription>
          </FieldLabel>
        </Field>
      </FieldGroup>
      <ActionError error={error} />
      <Footer pending={pending} label="Create tube" />
    </form>
  )
}

const ROOT = "__root__"

function CloneTubeForm({ dialog, tree, close }: BodyProps) {
  const { pending, error, run } = useServerAction()
  const { expand } = useExpandedFolders()
  const router = useRouter()
  const [includeItems, setIncludeItems] = React.useState(false)
  if (dialog.kind !== "cloneTube") return null
  const source = dialog.tube
  const options = flattenFolders(tree)

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const target = field(form, "folder")
    const folderId = target && target !== ROOT ? target : null
    run(
      () =>
        cloneTubeAction(source.id, {
          name: field(form, "name"),
          ...(options.length > 0 && { folderId }),
          includeItems,
        }),
      ({ tube, items }) => {
        if (tube.folderId) expand([tube.folderId])
        toast.success(
          includeItems
            ? `Tube “${tube.name}” created with ${items} item${items === 1 ? "" : "s"}`
            : `Tube “${tube.name}” created`
        )
        close()
        router.push(`/dashboard/tubes/${tube.id}`)
      }
    )
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Clone tube</DialogTitle>
        <DialogDescription>
          Creates a new tube with the description, enabled state, JSON schema
          and retry policy of “{source.name}”.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="clone-name">Name</FieldLabel>
          <Input
            id="clone-name"
            name="name"
            autoFocus
            defaultValue={`${source.name} (copy)`.slice(0, 200)}
            maxLength={200}
            aria-invalid={error?.code === "validation_error" || undefined}
          />
        </Field>
        {options.length > 0 && (
          <Field>
            <FieldLabel htmlFor="clone-folder">Folder</FieldLabel>
            <NativeSelect
              id="clone-folder"
              name="folder"
              className="w-full"
              defaultValue={source.folderId ?? ROOT}
            >
              <NativeSelectOption value={ROOT}>
                None (top level)
              </NativeSelectOption>
              {options.map((o) => (
                <NativeSelectOption key={o.id} value={o.id}>
                  {`${"  ".repeat(o.depth)}${o.name}`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Field orientation="horizontal">
          <Switch
            id="clone-items"
            checked={includeItems}
            onCheckedChange={(checked) => setIncludeItems(checked)}
          />
          <FieldLabel htmlFor="clone-items">
            Copy items
            <FieldDescription>
              Every item is copied as a new pending item (payload, metadata,
              tags, priority). Results, errors and history are not copied.
            </FieldDescription>
          </FieldLabel>
        </Field>
      </FieldGroup>
      <ActionError error={error} />
      <Footer pending={pending} label="Clone tube" />
    </form>
  )
}

function MoveForm({ dialog, tree, close }: BodyProps) {
  const { pending, error, run } = useServerAction()
  const { expand } = useExpandedFolders()
  const options = flattenFolders(tree)
  const isFolder = dialog.kind === "moveFolder"
  const subject = isFolder
    ? dialog.folder
    : dialog.kind === "moveTube"
      ? dialog.tube
      : null
  if (!subject) return null
  const currentParent = isFolder
    ? (subject as ExplorerFolder).parentId
    : (subject as ExplorerTube).folderId

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const target = field(new FormData(event.currentTarget), "target")
    if (!subject) return
    const targetId = target === ROOT ? null : target
    run<unknown>(
      () =>
        isFolder
          ? moveFolderAction(subject.id, targetId)
          : moveTubeAction(subject.id, targetId),
      () => {
        if (targetId) expand([targetId])
        toast.success(
          `Moved “${subject.name}” to ${folderPath(tree, targetId)}`
        )
        close()
      }
    )
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Move {isFolder ? "folder" : "tube"}</DialogTitle>
        <DialogDescription>
          “{subject.name}” is in {folderPath(tree, currentParent)}
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="move-target">Destination</FieldLabel>
        <NativeSelect
          id="move-target"
          name="target"
          className="w-full"
          defaultValue={currentParent ?? ROOT}
        >
          <NativeSelectOption value={ROOT}>
            {isFolder ? "/ (root)" : "None (top level)"}
          </NativeSelectOption>
          {options.map((o) => (
            <NativeSelectOption
              key={o.id}
              value={o.id}
              disabled={isFolder && o.id === subject.id}
            >
              {`${"  ".repeat(o.depth)}${o.name}`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {isFolder && (
          <FieldDescription>
            A folder cannot be moved into itself or one of its subfolders.
          </FieldDescription>
        )}
      </Field>
      <ActionError error={error} />
      <Footer pending={pending} label="Move" />
    </form>
  )
}

function DeleteConfirm({ dialog, close }: BodyProps) {
  const { pending, error, run } = useServerAction()
  const router = useRouter()
  const pathname = usePathname()
  const isFolder = dialog.kind === "deleteFolder"
  const subject = isFolder
    ? dialog.folder
    : dialog.kind === "deleteTube"
      ? dialog.tube
      : null
  // A "not empty" conflict turns the dialog into a second, explicit
  // confirmation that also deletes the contents.
  const notEmpty = error?.code === "conflict" ? error : null
  if (!subject) return null

  function onConfirm() {
    if (!subject) return
    const withContents = notEmpty !== null
    run<unknown>(
      () =>
        isFolder
          ? deleteFolderAction(subject.id, { recursive: withContents })
          : deleteTubeAction(subject.id, { force: withContents }),
      () => {
        toast.success(`Deleted “${subject.name}”`)
        close()
        if (
          !isFolder &&
          pathname.startsWith(`/dashboard/tubes/${subject.id}`)
        ) {
          router.push("/dashboard")
        }
      }
    )
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Delete {isFolder ? "folder" : "tube"}?</DialogTitle>
        <DialogDescription>
          “{subject.name}” will be permanently deleted.
        </DialogDescription>
      </DialogHeader>
      {notEmpty ? (
        <div
          role="alert"
          className="border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive"
        >
          <p className="font-medium">
            This {isFolder ? "folder" : "tube"} is not empty
            {describeContents(notEmpty.details)}.
          </p>
          <p>
            {isFolder
              ? "All subfolders, tubes and their items will be permanently deleted as well."
              : "All of its items will be permanently deleted as well."}{" "}
            This cannot be undone.
          </p>
        </div>
      ) : (
        <ActionError error={error} />
      )}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? "Deleting…" : notEmpty ? "Delete everything" : "Delete"}
        </Button>
      </DialogFooter>
    </div>
  )
}

/** " (2 subfolders, 1 tube)" from a not-empty conflict's details. */
function describeContents(details: unknown): string {
  if (!details || typeof details !== "object") return ""
  const d = details as Record<string, unknown>
  const parts: string[] = []
  const add = (n: unknown, one: string, many: string) => {
    if (typeof n === "number" && n > 0)
      parts.push(`${n} ${n === 1 ? one : many}`)
  }
  add(d.subfolders, "subfolder", "subfolders")
  add(d.tubes, "tube", "tubes")
  add(d.items, "item", "items")
  return parts.length ? ` (${parts.join(", ")})` : ""
}

"use client"

import {
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CopyIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  InboxIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  Share2Icon,
  SquarePlusIcon,
  Trash2Icon,
} from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import * as React from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  flattenFolders,
  tubeAncestorIds,
  type ExplorerFolder,
  type ExplorerTube,
} from "@/lib/dashboard/explorer"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { useExpandedFolders } from "./expanded-store"
import { useExplorer } from "./explorer-dialogs"

/** Currently selected tube id, from `/dashboard/tubes/<id>[/...]`. */
function useActiveTubeId(): string | null {
  const pathname = usePathname()
  return /^\/dashboard\/tubes\/([^/]+)/.exec(pathname)?.[1] ?? null
}

export function FolderTree() {
  const { tree, rootTubes, openDialog } = useExplorer()
  const isEmpty = tree.length === 0 && rootTubes.length === 0
  const { expanded, toggle, expand, collapseAll } = useExpandedFolders()
  const activeTubeId = useActiveTubeId()
  const allFolderIds = React.useMemo(
    () => flattenFolders(tree).map((f) => f.id),
    [tree]
  )
  // Ignore stale ids (deleted folders) when deciding the toggle direction.
  const anyExpanded = allFolderIds.some((id) => expanded.has(id))
  // Default new tubes to the folder of the tube being viewed.
  const activeFolderId = React.useMemo(
    () =>
      activeTubeId
        ? (tubeAncestorIds(tree, activeTubeId)?.at(-1) ?? null)
        : null,
    [tree, activeTubeId]
  )

  // Reveal the selected tube (e.g. deep link / navigation from elsewhere).
  React.useEffect(() => {
    if (!activeTubeId) return
    const ancestors = tubeAncestorIds(tree, activeTubeId)
    if (ancestors) expand(ancestors)
  }, [activeTubeId, tree, expand])

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Explorer</SidebarGroupLabel>
      <div className="absolute top-3.5 right-3 flex gap-1">
        <SidebarGroupAction
          className="static"
          title={anyExpanded ? "Collapse all" : "Expand all"}
          aria-label={
            anyExpanded ? "Collapse all folders" : "Expand all folders"
          }
          disabled={allFolderIds.length === 0}
          onClick={() => (anyExpanded ? collapseAll() : expand(allFolderIds))}
        >
          {anyExpanded ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />}
        </SidebarGroupAction>
        <SidebarGroupAction
          className="static"
          title="New folder"
          aria-label="New root folder"
          onClick={() => openDialog({ kind: "createFolder", parentId: null })}
        >
          <FolderPlusIcon />
        </SidebarGroupAction>
      </div>
      <SidebarGroupContent>
        <Button
          size="sm"
          className="mb-2 w-full justify-start"
          onClick={() =>
            openDialog({ kind: "createTube", folderId: activeFolderId })
          }
        >
          <PlusIcon /> New tube
        </Button>
        {isEmpty ? (
          <div className="px-2 py-4 text-xs text-muted-foreground">
            No tubes yet. Folders are optional; use them to group tubes.
          </div>
        ) : (
          <SidebarMenu role="tree" aria-label="Folders and tubes">
            {tree.map((folder) => (
              <FolderNode
                key={folder.id}
                folder={folder}
                expanded={expanded}
                toggle={toggle}
                activeTubeId={activeTubeId}
              />
            ))}
            {rootTubes.map((tube) => (
              <TubeNode key={tube.id} tube={tube} activeTubeId={activeTubeId} />
            ))}
          </SidebarMenu>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

type NodeProps = {
  expanded: Set<string>
  toggle: (id: string) => void
  activeTubeId: string | null
}

function FolderNode({
  folder,
  ...props
}: NodeProps & { folder: ExplorerFolder }) {
  const { expanded, toggle } = props
  const { openDialog } = useExplorer()
  const isOpen = expanded.has(folder.id)
  const isEmpty = folder.children.length === 0 && folder.tubes.length === 0

  return (
    <li
      role="treeitem"
      aria-expanded={isOpen}
      aria-selected={false}
      className="min-w-0"
    >
      <TreeRow>
        <SidebarMenuButton
          onClick={() => toggle(folder.id)}
          title={folder.description || folder.name}
          className="group-has-data-[sidebar=menu-action]/menu-item:pr-14"
        >
          <ChevronRightIcon
            className={cn(
              "transition-transform",
              isOpen && "rotate-90",
              isEmpty && "opacity-50"
            )}
          />
          {isOpen ? <FolderOpenIcon /> : <FolderIcon />}
          <span>{folder.name}</span>
        </SidebarMenuButton>
        <SidebarMenuAction
          showOnHover
          className="right-7"
          title="New tube"
          aria-label={`New tube in ${folder.name}`}
          onClick={() =>
            openDialog({ kind: "createTube", folderId: folder.id })
          }
        >
          <SquarePlusIcon />
        </SidebarMenuAction>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuAction
                showOnHover
                aria-label={`Actions for ${folder.name}`}
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-44">
            <DropdownMenuItem
              onClick={() =>
                openDialog({ kind: "createFolder", parentId: folder.id })
              }
            >
              <FolderPlusIcon /> New subfolder
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                openDialog({ kind: "createTube", folderId: folder.id })
              }
            >
              <InboxIcon /> New tube
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => openDialog({ kind: "renameFolder", folder })}
            >
              <PencilIcon /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => openDialog({ kind: "moveFolder", folder })}
            >
              <FolderInputIcon /> Move
            </DropdownMenuItem>
            <DropdownMenuItem
              render={<Link href={`/dashboard/mcp?folder=${folder.id}`} />}
            >
              <PlugIcon /> Connect via MCP
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                openDialog({
                  kind: "share",
                  target: { kind: "folder", id: folder.id, name: folder.name },
                })
              }
            >
              <Share2Icon /> Share link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => openDialog({ kind: "deleteFolder", folder })}
            >
              <Trash2Icon /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TreeRow>
      {isOpen && isEmpty && (
        <SidebarMenuSub role="group" className="mr-0 pr-0">
          <li className="min-w-0">
            <SidebarMenuSubButton
              render={<button type="button" />}
              className="w-full text-muted-foreground"
              onClick={() =>
                openDialog({ kind: "createTube", folderId: folder.id })
              }
            >
              <PlusIcon />
              <span>New tube</span>
            </SidebarMenuSubButton>
          </li>
        </SidebarMenuSub>
      )}
      {isOpen && !isEmpty && (
        <SidebarMenuSub role="group" className="mr-0 pr-0">
          {folder.children.map((child) => (
            <FolderNode key={child.id} folder={child} {...props} />
          ))}
          {folder.tubes.map((tube) => (
            <TubeNode
              key={tube.id}
              tube={tube}
              activeTubeId={props.activeTubeId}
            />
          ))}
        </SidebarMenuSub>
      )}
    </li>
  )
}

function TubeNode({
  tube,
  activeTubeId,
}: {
  tube: ExplorerTube
  activeTubeId: string | null
}) {
  const { openDialog } = useExplorer()
  const { isMobile, setOpenMobile } = useSidebar()
  const isActive = tube.id === activeTubeId

  return (
    <li role="treeitem" aria-selected={isActive} className="min-w-0">
      <TreeRow>
        <SidebarMenuButton
          isActive={isActive}
          title={tube.description || tube.name}
          render={
            <Link
              href={`/dashboard/tubes/${tube.id}`}
              onClick={() => isMobile && setOpenMobile(false)}
            />
          }
        >
          <InboxIcon className={cn(!tube.enabled && "opacity-40")} />
          <span className={cn(!tube.enabled && "text-muted-foreground")}>
            {tube.name}
          </span>
        </SidebarMenuButton>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuAction
                showOnHover
                aria-label={`Actions for ${tube.name}`}
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-44">
            <DropdownMenuItem
              onClick={() => openDialog({ kind: "moveTube", tube })}
            >
              <FolderInputIcon /> Move
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => openDialog({ kind: "cloneTube", tube })}
            >
              <CopyIcon /> Clone
            </DropdownMenuItem>
            <DropdownMenuItem
              render={<Link href={`/dashboard/mcp?tube=${tube.id}`} />}
            >
              <PlugIcon /> Connect via MCP
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                openDialog({
                  kind: "share",
                  target: { kind: "tube", id: tube.id, name: tube.name },
                })
              }
            >
              <Share2Icon /> Share link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => openDialog({ kind: "deleteTube", tube })}
            >
              <Trash2Icon /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TreeRow>
    </li>
  )
}

/**
 * One row (button + actions). The hover group lives on the row, not on the
 * `<li>`, so hovering a folder doesn't reveal the actions of all descendants.
 */
function TreeRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className="group/menu-item relative"
    >
      {children}
    </div>
  )
}

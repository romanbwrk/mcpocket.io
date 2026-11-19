import {
  ChevronRightIcon,
  EyeIcon,
  ImageIcon,
  InboxIcon,
  ListIcon,
  PlugIcon,
} from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { CloneTubeButton } from "@/components/dashboard/clone-tube-button"
import { ImportItemsDialog } from "@/components/dashboard/import-items-dialog"
import { ResetTubeButton } from "@/components/dashboard/reset-tube-button"
import { ShareLinkButton } from "@/components/dashboard/share-link-button"
import { TubeSettingsDialog } from "@/components/dashboard/tube-settings-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { NotFoundError } from "@mcpocket/core/domain/errors"
import type { Folder, Tube } from "@mcpocket/core/domain/schemas"
import type { Services } from "@mcpocket/core/services"

/** The tube of a tube page; unknown or out-of-scope id → 404 page. */
export async function loadTube(services: Services, id: string): Promise<Tube> {
  try {
    return await services.tubes.get(id)
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    throw error
  }
}

/** Root → parent folder chain of a tube (for the breadcrumb). */
async function folderPath(
  services: Services,
  folderId: string | null
): Promise<Folder[]> {
  const path: Folder[] = []
  const seen = new Set<string>()
  let current: string | null = folderId
  while (current && !seen.has(current)) {
    seen.add(current)
    const folder: Folder | null = await services.folders
      .get(current)
      .catch(() => null)
    if (!folder) break
    path.unshift(folder)
    current = folder.parentId
  }
  return path
}

export type TubeTab = "items" | "preview" | "media"

const TABS: { id: TubeTab; label: string; icon: typeof ListIcon }[] = [
  { id: "items", label: "Items", icon: ListIcon },
  { id: "preview", label: "Preview", icon: EyeIcon },
  { id: "media", label: "Media", icon: ImageIcon },
]

const tabHref = (tubeId: string, tab: TubeTab) =>
  tab === "items"
    ? `/dashboard/tubes/${tubeId}`
    : `/dashboard/tubes/${tubeId}/${tab}`

/**
 * Shared header of the tube pages: breadcrumb, name, actions (MCP, import,
 * reset, clone, settings) and the Items / Preview / Media tabs.
 */
export async function TubeHeader({
  services,
  tube,
  active,
}: {
  services: Services
  tube: Tube
  active: TubeTab
}) {
  const [path, stats, allTubes] = await Promise.all([
    folderPath(services, tube.folderId),
    services.statistics.tube(tube.id).catch(() => null),
    services.tubes
      .list({ limit: 200 })
      .then((page) => page.data)
      .catch(() => [] as Tube[]),
  ])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <nav
            aria-label="Breadcrumb"
            className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          >
            {path.map((folder) => (
              <span key={folder.id} className="flex items-center gap-1">
                {folder.name}
                <ChevronRightIcon className="size-3" />
              </span>
            ))}
            <span className="text-foreground">{tube.name}</span>
          </nav>
          <div className="flex flex-wrap items-center gap-2">
            <InboxIcon className="size-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold tracking-tight">
              {tube.name}
            </h1>
            <Badge variant={tube.enabled ? "secondary" : "outline"}>
              {tube.enabled ? "Enabled" : "Disabled"}
            </Badge>
            {tube.schemaDefinition && <Badge variant="outline">Schema</Badge>}
          </div>
          {tube.description && (
            <p className="text-xs text-muted-foreground">{tube.description}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            title="Connect an MCP client to this tube only"
            render={<Link href={`/dashboard/mcp?tube=${tube.id}`} />}
          >
            <PlugIcon data-icon="inline-start" />
            MCP
          </Button>
          <ShareLinkButton
            target={{ kind: "tube", id: tube.id, name: tube.name }}
          />
          <ImportItemsDialog tubeId={tube.id} enabled={tube.enabled} />
          <ResetTubeButton
            tubeId={tube.id}
            tubeName={tube.name}
            counts={stats?.counts}
          />
          <CloneTubeButton
            tube={{
              id: tube.id,
              folderId: tube.folderId,
              name: tube.name,
              description: tube.description,
              enabled: tube.enabled,
            }}
          />
          <TubeSettingsDialog
            tube={{
              id: tube.id,
              name: tube.name,
              description: tube.description,
              enabled: tube.enabled,
              schemaDefinition: tube.schemaDefinition,
              retryPolicy: tube.retryPolicy,
              leaseSeconds: tube.leaseSeconds,
              nextTubeIds: tube.nextTubeIds,
            }}
            retryDefaults={services.ctx.retryDefaults}
            leaseDefault={services.ctx.leaseSeconds}
            tubeOptions={allTubes
              .filter((t) => t.id !== tube.id)
              .map((t) => ({ id: t.id, name: t.name }))}
          />
        </div>
      </div>
      <nav aria-label="Tube views" className="flex gap-1 border-b">
        {TABS.map((tab) => (
          <Link
            key={tab.id}
            href={tabHref(tube.id, tab.id)}
            aria-current={tab.id === active ? "page" : undefined}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs transition-colors",
              tab.id === active
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <tab.icon className="size-3.5" />
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}

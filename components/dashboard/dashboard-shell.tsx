"use client"

import { ThemeToggle } from "@/components/theme-toggle"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import type { ExplorerFolder, ExplorerTube } from "@/lib/dashboard/explorer"

import { AppSidebar } from "./app-sidebar"
import { ExplorerProvider } from "./explorer-dialogs"
import { LiveIndicator, LiveUpdatesProvider } from "./live-updates"

/**
 * Dashboard chrome: collapsible sidebar (nav + folder explorer, a sheet on
 * mobile), sticky header and the routed page in the inset. Live updates
 * (SSE → router.refresh) are wired here for every dashboard page.
 */
export function DashboardShell({
  tree,
  rootTubes,
  username,
  defaultSidebarOpen,
  children,
}: {
  tree: ExplorerFolder[]
  rootTubes: ExplorerTube[]
  username: string
  defaultSidebarOpen: boolean
  children: React.ReactNode
}) {
  return (
    <LiveUpdatesProvider>
      <ExplorerProvider tree={tree} rootTubes={rootTubes}>
        <SidebarProvider
          defaultOpen={defaultSidebarOpen}
          style={{ "--sidebar-width": "18rem" } as React.CSSProperties}
        >
          <AppSidebar username={username} />
          <SidebarInset className="min-w-0">
            <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70">
              <SidebarTrigger />
              <Separator orientation="vertical" className="mx-1 h-4" />
              <span className="truncate text-xs text-muted-foreground">
                MCPocket dashboard
              </span>
              <div className="ml-auto flex items-center gap-1">
                <LiveIndicator />
                <ThemeToggle />
              </div>
            </header>
            <div className="flex-1 p-4 md:p-6">{children}</div>
          </SidebarInset>
        </SidebarProvider>
      </ExplorerProvider>
    </LiveUpdatesProvider>
  )
}

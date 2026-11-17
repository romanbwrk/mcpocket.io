import type { Metadata } from "next"
import { cookies } from "next/headers"

import { DashboardShell } from "@/components/dashboard/dashboard-shell"
import { getCurrentUser, getUserServices } from "@/lib/auth/server"
import { toExplorerTree, toExplorerTubes } from "@/lib/dashboard/explorer"

export const metadata: Metadata = {
  title: { default: "Dashboard", template: "%s · MCPocket" },
}

/**
 * Authenticated dashboard shell. The folder tree is loaded here (through the
 * services, as the logged-in admin) and stays mounted across navigation;
 * server actions call `revalidatePath("/dashboard", "layout")` to refresh it.
 */
export default async function DashboardLayout({
  children,
}: LayoutProps<"/dashboard">) {
  const [user, services, cookieStore] = await Promise.all([
    getCurrentUser(),
    getUserServices(),
    cookies(),
  ])
  const hierarchy = await services.folders.hierarchy()
  return (
    <DashboardShell
      tree={toExplorerTree(hierarchy.folders)}
      rootTubes={toExplorerTubes(hierarchy.tubes)}
      username={user.username}
      defaultSidebarOpen={cookieStore.get("sidebar_state")?.value !== "false"}
    >
      {children}
    </DashboardShell>
  )
}

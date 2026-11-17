"use client"

import {
  BotIcon,
  ImageIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  PlugIcon,
  UserIcon,
  WebhookIcon,
} from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { logout } from "@/app/login/actions"
import { BrandLogo } from "@/components/brand"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"

import { FolderTree } from "./folder-tree"

/**
 * Primary dashboard navigation; `match` decides the active state.
 */
export const DASHBOARD_NAV = [
  {
    href: "/dashboard",
    label: "Overview",
    icon: LayoutDashboardIcon,
    match: (path: string) => path === "/dashboard",
  },
  {
    href: "/dashboard/agents",
    label: "Agents",
    icon: BotIcon,
    match: (path: string) =>
      path === "/dashboard/agents" || path.startsWith("/dashboard/agents/"),
  },
  {
    href: "/dashboard/media",
    label: "Media",
    icon: ImageIcon,
    match: (path: string) => path === "/dashboard/media",
  },
  {
    href: "/dashboard/access",
    label: "Access",
    icon: KeyRoundIcon,
    match: (path: string) => path === "/dashboard/access",
  },
  {
    href: "/dashboard/mcp",
    label: "MCP",
    icon: PlugIcon,
    match: (path: string) => path === "/dashboard/mcp",
  },
  {
    href: "/dashboard/webhooks",
    label: "Webhooks",
    icon: WebhookIcon,
    match: (path: string) => path === "/dashboard/webhooks",
  },
] as const

export function AppSidebar({ username }: { username: string }) {
  const pathname = usePathname()
  const { isMobile, setOpenMobile } = useSidebar()

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/dashboard" />}>
              <BrandLogo showTagline />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarSeparator className="mx-0" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {DASHBOARD_NAV.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={item.match(pathname)}
                    render={
                      <Link
                        href={item.href}
                        onClick={() => isMobile && setOpenMobile(false)}
                      />
                    }
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <FolderTree />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-1">
            <div className="flex min-w-0 flex-1 items-center gap-2 px-2 text-xs">
              <UserIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate" title="Signed in as">
                {username}
              </span>
            </div>
            <form action={logout}>
              <SidebarMenuButton
                type="submit"
                className="w-auto"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOutIcon />
                <span>Sign out</span>
              </SidebarMenuButton>
            </form>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

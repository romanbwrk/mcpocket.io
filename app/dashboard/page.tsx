import Link from "next/link"
import { FolderTreeIcon, InboxIcon, LayersIcon, UsersIcon } from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { NewTubeButton } from "@/components/dashboard/new-tube-button"
import { getUserServices } from "@/lib/auth/server"
import { BRAND } from "@/lib/brand"

export const metadata = { title: "Overview" }

export default async function DashboardPage() {
  const services = await getUserServices()
  const stats = await services.statistics.global()
  const tiles: {
    label: string
    value: number
    icon: typeof FolderTreeIcon
    href?: string
  }[] = [
    { label: "Folders", value: stats.folders, icon: FolderTreeIcon },
    { label: "Tubes", value: stats.tubes, icon: InboxIcon },
    { label: "Items", value: stats.counts.total, icon: LayersIcon },
    {
      label: "Agents",
      value: stats.agents,
      icon: UsersIcon,
      href: "/dashboard/agents",
    },
  ]
  const statuses = [
    ["Pending", stats.counts.pending],
    ["Processing", stats.counts.processing],
    ["Completed", stats.counts.completed],
    ["Failed", stats.counts.failed],
    ["Retry", stats.counts.retry],
    ["Archived", stats.counts.archived],
  ] as const

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
          <p className="text-xs text-muted-foreground">{BRAND.positioning}</p>
        </div>
        <NewTubeButton />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} size="sm">
            <CardHeader>
              <CardDescription className="flex items-center gap-1.5">
                <t.icon className="size-3.5" /> {t.label}
              </CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {t.href ? (
                  <Link
                    href={t.href}
                    className="underline-offset-4 hover:underline"
                  >
                    {t.value}
                  </Link>
                ) : (
                  t.value
                )}
              </CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Items by status</CardTitle>
          <CardDescription>
            Across all tubes (deleted items excluded)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
            {statuses.map(([label, value]) => (
              <div key={label} className="flex justify-between border-b pb-1">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Pick a tube in the explorer to inspect it, or use{" "}
        <span className="font-medium text-foreground">New tube</span> to create
        one. Folders are optional: add one with the folder button next to
        “Explorer” to group tubes.
      </p>
    </div>
  )
}

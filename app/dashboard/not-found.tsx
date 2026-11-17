import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"

export default function DashboardNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 py-12">
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="text-xs text-muted-foreground">
        This tube or folder does not exist (anymore). Pick another one in the
        explorer.
      </p>
      <Link
        href="/dashboard"
        className={buttonVariants({ variant: "outline" })}
      >
        Back to overview
      </Link>
    </div>
  )
}

import { ArrowRightIcon, BookOpenIcon } from "lucide-react"
import Link from "next/link"

import { BrandLogo } from "@/components/brand"
import { BrandPanel } from "@/components/brand-panel"
import { ThemeToggle } from "@/components/theme-toggle"
import { buttonVariants } from "@/components/ui/button"
import { BRAND } from "@/lib/brand"

export default function LandingPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-14 items-center justify-between border-b px-4 md:px-8">
        <BrandLogo />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/dashboard" className={buttonVariants({ size: "sm" })}>
            Dashboard
          </Link>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center gap-10 px-4 py-12 md:px-8">
        <BrandPanel showLogo={false} />
        <div className="flex flex-wrap gap-2">
          <Link href="/dashboard" className={buttonVariants({ size: "lg" })}>
            Open dashboard <ArrowRightIcon />
          </Link>
          <p className="flex items-center gap-2 self-center text-xs text-muted-foreground">
            <BookOpenIcon className="size-3.5" />
            Agents connect via MCP at{" "}
            <code className="font-mono">/api/mcp</code>· REST at{" "}
            <code className="font-mono">/api/*</code>
          </p>
        </div>
      </main>
      <footer className="border-t px-4 py-4 text-xs text-muted-foreground md:px-8">
        {BRAND.name} · {BRAND.domain}
      </footer>
    </div>
  )
}

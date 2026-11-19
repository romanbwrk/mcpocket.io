import type { Metadata } from "next"

import { BrandLogo } from "@/components/brand"
import { ThemeToggle } from "@/components/theme-toggle"

export const metadata: Metadata = {
  // The API key is in the URL: never index it, never send it as a Referer.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
}

/** Public, key-authenticated views of a tube or folder (no dashboard session). */
export default function ShareLayout({ children }: LayoutProps<"/share">) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background/90 px-4 py-2 backdrop-blur">
        <BrandLogo />
        <ThemeToggle />
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-5">
        {children}
      </main>
    </div>
  )
}

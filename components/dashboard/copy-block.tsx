"use client"

import { CheckIcon, CopyIcon } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Copy-to-clipboard icon button with a short "copied" state. */
export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={className}
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        setCopied(true)
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

/** Monospace code snippet with a copy button. */
export function CopyBlock({
  code,
  title,
  className,
}: {
  code: string
  title?: string
  className?: string
}) {
  return (
    <div className={cn("border bg-muted/30", className)}>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1">
        <span className="truncate text-xs text-muted-foreground">
          {title ?? ""}
        </span>
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  )
}

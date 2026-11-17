"use client"

import { cn } from "cn"
import * as React from "react"

import { tokenizeJson, type JsonTokenType } from "@/lib/dashboard/json-text"

const TOKEN_CLASS: Record<JsonTokenType, string> = {
  key: "text-sky-700 dark:text-sky-300",
  string: "text-emerald-700 dark:text-emerald-300",
  number: "text-amber-700 dark:text-amber-300",
  literal: "text-violet-700 dark:text-violet-300",
  punct: "text-muted-foreground",
  space: "",
  invalid: "text-destructive underline decoration-wavy",
}

const CODE_CLASS =
  "m-0 p-2.5 font-mono text-[0.7rem] leading-5 whitespace-pre [tab-size:2]"

/** Syntax-highlighted JSON text (no wrapping). */
function Highlighted({ text }: { text: string }) {
  const tokens = React.useMemo(() => tokenizeJson(text), [text])
  return tokens.map((token, i) =>
    token.type === "space" ? (
      token.text
    ) : (
      <span key={i} className={TOKEN_CLASS[token.type]}>
        {token.text}
      </span>
    )
  )
}

/** Read-only, highlighted JSON block (results, errors, metadata). */
export function JsonView({
  value,
  className,
  ...props
}: { value: unknown; className?: string } & React.ComponentProps<"pre">) {
  const text = value === undefined ? "" : JSON.stringify(value, null, 2)
  return (
    <pre
      className={cn(
        CODE_CLASS,
        "max-h-64 overflow-auto border bg-muted/40",
        className
      )}
      {...props}
    >
      <Highlighted text={text} />
    </pre>
  )
}

/**
 * Plain `<textarea>` over a highlighted `<pre>` (same font metrics, scroll
 * synced): native editing, undo and selection, no editor dependency. Tab
 * inserts two spaces.
 */
export function JsonEditor({
  value,
  onChange,
  invalid,
  className,
  ...props
}: {
  value: string
  onChange: (value: string) => void
  invalid?: boolean
  className?: string
} & Omit<React.ComponentProps<"textarea">, "value" | "onChange">) {
  const preRef = React.useRef<HTMLPreElement>(null)

  function syncScroll(event: React.UIEvent<HTMLTextAreaElement>) {
    if (!preRef.current) return
    preRef.current.scrollTop = event.currentTarget.scrollTop
    preRef.current.scrollLeft = event.currentTarget.scrollLeft
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab" || event.shiftKey || props.readOnly) return
    event.preventDefault()
    const el = event.currentTarget
    const { selectionStart: start, selectionEnd: end } = el
    onChange(`${value.slice(0, start)}  ${value.slice(end)}`)
    requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2))
  }

  return (
    <div
      className={cn(
        "relative border bg-muted/40 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50",
        invalid && "border-destructive/60 focus-within:border-destructive",
        className
      )}
    >
      <pre
        ref={preRef}
        aria-hidden
        className={cn(
          CODE_CLASS,
          "pointer-events-none absolute inset-0 overflow-hidden"
        )}
      >
        <Highlighted text={value} />
        {/* keep the last (empty) line measurable */}{" "}
      </pre>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
        aria-invalid={invalid || undefined}
        className={cn(
          CODE_CLASS,
          "relative block h-72 min-h-32 w-full resize-y overflow-auto bg-transparent text-transparent caret-foreground outline-none selection:bg-sky-500/25 selection:text-transparent"
        )}
        {...props}
      />
    </div>
  )
}

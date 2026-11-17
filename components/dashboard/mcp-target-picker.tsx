"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useTransition } from "react"

import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@/components/ui/native-select"

export type McpTargetOption = {
  kind: "tube" | "folder"
  id: string
  label: string
}

const optionValue = (o: Pick<McpTargetOption, "kind" | "id">) =>
  `${o.kind}:${o.id}`

/** Replaces some query params of the current page, keeping the others. */
function useQueryUpdate() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    const query = next.toString()
    startTransition(() =>
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      })
    )
  }
  return { pending, update }
}

/**
 * Chooses what the MCP page's endpoints and snippets connect to: the whole
 * workspace, one folder subtree (`?folder=<id>`) or one tube (`?tube=<id>`).
 */
export function McpTargetPicker({
  targets,
  value,
}: {
  targets: McpTargetOption[]
  value: Pick<McpTargetOption, "kind" | "id"> | null
}) {
  const { pending, update } = useQueryUpdate()
  const folders = targets.filter((t) => t.kind === "folder")
  const tubes = targets.filter((t) => t.kind === "tube")

  return (
    <NativeSelect
      aria-label="Connection target"
      className="w-full sm:w-[28rem]"
      value={value ? optionValue(value) : ""}
      disabled={pending}
      onChange={(event) => {
        const [kind, id] = event.target.value.split(":")
        update({
          tube: kind === "tube" ? id : null,
          folder: kind === "folder" ? id : null,
        })
      }}
    >
      <NativeSelectOption value="">
        Whole workspace (everything the key can reach)
      </NativeSelectOption>
      {folders.length > 0 && (
        <NativeSelectOptGroup label="Folder (with everything below it)">
          {folders.map((t) => (
            <NativeSelectOption key={t.id} value={optionValue(t)}>
              {t.label}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
      )}
      {tubes.length > 0 && (
        <NativeSelectOptGroup label="Single tube">
          {tubes.map((t) => (
            <NativeSelectOption key={t.id} value={optionValue(t)}>
              {t.label}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
      )}
    </NativeSelect>
  )
}

export type McpKeyOption = { id: string; label: string; viewable: boolean }

/**
 * Chooses the API key (`?key=<id>`) whose secret is filled into the MCP
 * page's URLs and snippets. Only keys created with "show each time" have a
 * retrievable secret; the others are listed disabled.
 */
export function McpKeyPicker({
  keys,
  value,
}: {
  keys: McpKeyOption[]
  value: string | null
}) {
  const { pending, update } = useQueryUpdate()
  return (
    <NativeSelect
      aria-label="API key"
      className="w-full sm:w-[28rem]"
      value={value ?? ""}
      disabled={pending}
      onChange={(event) => update({ key: event.target.value || null })}
    >
      <NativeSelectOption value="">
        No key (placeholders like &lt;secret&gt;)
      </NativeSelectOption>
      {keys.map((k) => (
        <NativeSelectOption key={k.id} value={k.id} disabled={!k.viewable}>
          {k.viewable ? k.label : `${k.label} — secret shown once only`}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  )
}

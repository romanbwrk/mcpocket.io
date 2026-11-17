"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"

/**
 * Expand/collapse state of the folder tree. Lives outside React (module +
 * localStorage) so it survives client navigation (the dashboard layout keeps
 * the tree mounted anyway) and full reloads, without hydration mismatches:
 * the server snapshot is "nothing expanded".
 */
const STORAGE_KEY = "mcpocket.explorer.expanded"
const EMPTY = "[]"
const listeners = new Set<() => void>()
let memory: string | null = null

function read(): string {
  if (memory !== null) return memory
  try {
    memory = window.localStorage.getItem(STORAGE_KEY) ?? EMPTY
  } catch {
    memory = EMPTY
  }
  return memory
}

function write(ids: Set<string>) {
  memory = JSON.stringify([...ids])
  try {
    window.localStorage.setItem(STORAGE_KEY, memory)
  } catch {
    // storage unavailable (private mode): keep in memory only
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      memory = null
      listener()
    }
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

function current(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(read())
    return new Set(Array.isArray(parsed) ? parsed.map(String) : [])
  } catch {
    return new Set()
  }
}

export function useExpandedFolders() {
  const raw = useSyncExternalStore(subscribe, read, () => EMPTY)
  const expanded = useMemo(() => {
    try {
      return new Set<string>(JSON.parse(raw))
    } catch {
      return new Set<string>()
    }
  }, [raw])

  const toggle = useCallback((id: string) => {
    const next = current()
    if (next.has(id)) next.delete(id)
    else next.add(id)
    write(next)
  }, [])

  const expand = useCallback((ids: string[]) => {
    const next = current()
    if (ids.every((id) => next.has(id))) return
    ids.forEach((id) => next.add(id))
    write(next)
  }, [])

  const collapseAll = useCallback(() => write(new Set()), [])

  return { expanded, toggle, expand, collapseAll }
}

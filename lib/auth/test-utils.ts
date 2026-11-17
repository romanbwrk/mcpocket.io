import { vi } from "vitest"

/**
 * Test doubles for the Next.js request APIs used by the dashboard DAL and
 * server actions. Use with (factories must import lazily):
 *   vi.mock("server-only", () => ({}))
 *   vi.mock("next/headers", async () => (await import("@/lib/auth/test-utils")).nextHeadersMock)
 *   (same for next/navigation → nextNavigationMock, next/cache → nextCacheMock)
 */
export const cookieJar = new Map<string, { value: string; options?: unknown }>()

/** Incoming request headers seen by `headers()` (e.g. x-forwarded-for). */
export const requestHeaders = new Map<string, string>()

export const nextHeadersMock = {
  headers: async () => new Headers([...requestHeaders]),
  cookies: async () => ({
    get: (name: string) => {
      const c = cookieJar.get(name)
      return c ? { name, value: c.value } : undefined
    },
    set: (name: string, value: string, options?: unknown) => {
      cookieJar.set(name, { value, options })
    },
    delete: (name: string) => {
      cookieJar.delete(name)
    },
  }),
}

export class RedirectError extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT ${url}`)
  }
}

export const nextNavigationMock = {
  redirect: (url: string) => {
    throw new RedirectError(url)
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND")
  },
}

export const nextCacheMock = {
  revalidatePath: vi.fn(),
  refresh: vi.fn(),
}

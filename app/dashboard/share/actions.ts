"use server"

import { randomBytes } from "node:crypto"

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import QRCode from "qrcode"

import { getUserServices } from "@/lib/auth/server"
import type { ActionResult } from "@/lib/dashboard/explorer"
import type {
  ShareKeyOption,
  ShareLink,
  ShareTarget,
} from "@/lib/dashboard/share"
import { API_KEY_QUERY_PARAM } from "@mcpocket/core/api/auth"
import { ROLE_META } from "@mcpocket/core/domain/access"
import { ValidationError } from "@mcpocket/core/domain/errors"
import { publicOrigin, type Services } from "@mcpocket/core/services"
import type { ApiKeyView } from "@mcpocket/core/services/api-keys"
import { normalizeError } from "@mcpocket/core/services/errors"

/**
 * Public share links of a tube / folder (`/share/{tubes|folders}/{id}?api_key=`).
 * Managed key secrets are stored hashed, so only keys created with
 * "show each time" (`secretVisibility: "always"`) can be put into a link;
 * "Create a read-only key" makes one scoped to just the shared target.
 */

async function run<T>(
  fn: (services: Services) => Promise<T>
): Promise<ActionResult<T>> {
  const services = await getUserServices()
  try {
    return { ok: true, data: await fn(services) }
  } catch (error) {
    return { ok: false, error: normalizeError(error) }
  }
}

/** Folder ids whose scope covers the target (its folder chain, plus itself for folders). */
async function coveringFolderIds(
  services: Services,
  target: ShareTarget
): Promise<{ folders: Set<string>; name: string }> {
  let current: string | null
  let name: string
  if (target.kind === "tube") {
    const tube = await services.tubes.get(target.id)
    current = tube.folderId
    name = tube.name
  } else {
    const folder = await services.folders.get(target.id)
    current = folder.id
    name = folder.name
  }
  const folders = new Set<string>()
  while (current && !folders.has(current)) {
    folders.add(current)
    current =
      (await services.folders.get(current).catch(() => null))?.parentId ?? null
  }
  return { folders, name }
}

const covers = (key: ApiKeyView, target: ShareTarget, folders: Set<string>) =>
  key.scope === null ||
  key.scope.folderIds.some((id) => folders.has(id)) ||
  (target.kind === "tube" && key.scope.tubeIds.includes(target.id))

const usable = (key: ApiKeyView) =>
  key.source === "managed" &&
  key.status === "active" &&
  key.secretVisibility === "always"

/** Keys that can open the target's share page (readonly first). */
export async function shareKeyOptionsAction(
  target: ShareTarget
): Promise<ActionResult<ShareKeyOption[]>> {
  return run(async (services) => {
    const [{ folders }, keys] = await Promise.all([
      coveringFolderIds(services, target),
      services.apiKeys.list(),
    ])
    return keys
      .filter((k) => usable(k) && covers(k, target, folders))
      .sort(
        (a, b) =>
          Number(b.role === "readonly") - Number(a.role === "readonly") ||
          Number(b.scope !== null) - Number(a.scope !== null) ||
          a.id.localeCompare(b.id)
      )
      .map((k) => ({
        id: k.id,
        description: k.description,
        role: k.role,
        roleLabel: ROLE_META[k.role].label,
        scoped: k.scope !== null,
      }))
  })
}

async function buildLink(
  services: Services,
  target: ShareTarget,
  keyId: string
): Promise<ShareLink> {
  const secret = await services.apiKeys.revealSecret(keyId)
  const origin = publicOrigin(await headers())
  const path = target.kind === "tube" ? "tubes" : "folders"
  const url = `${origin}/share/${path}/${encodeURIComponent(target.id)}?${API_KEY_QUERY_PARAM}=${encodeURIComponent(secret)}`
  const svg = await QRCode.toString(url, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
  })
  return {
    keyId,
    url,
    qr: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  }
}

/** The share URL (+ QR code) of the target with an existing key. */
export async function shareLinkAction(
  target: ShareTarget,
  keyId: string
): Promise<ActionResult<ShareLink>> {
  return run(async (services) => {
    const [{ folders }, keys] = await Promise.all([
      coveringFolderIds(services, target),
      services.apiKeys.list(),
    ])
    const key = keys.find((k) => k.id === keyId)
    if (!key || !usable(key) || !covers(key, target, folders)) {
      throw new ValidationError(
        `API key "${keyId}" cannot open this share link`
      )
    }
    return buildLink(services, target, keyId)
  })
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "link"

/** New read-only key scoped to just the target, viewable later, and its link. */
export async function createShareKeyAction(
  target: ShareTarget
): Promise<ActionResult<ShareLink>> {
  const result = await run(async (services) => {
    const { name } = await coveringFolderIds(services, target)
    const { key } = await services.apiKeys.create({
      id: `share-${slug(name)}-${randomBytes(3).toString("hex")}`,
      description: `Share link: ${target.kind} “${name}”`,
      role: "readonly",
      scope:
        target.kind === "tube"
          ? { folderIds: [], tubeIds: [target.id] }
          : { folderIds: [target.id], tubeIds: [] },
      secretVisibility: "always",
    })
    return buildLink(services, target, key.id)
  })
  if (result.ok) revalidatePath("/dashboard/access")
  return result
}

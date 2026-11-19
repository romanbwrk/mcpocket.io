import type { Role } from "@mcpocket/core/domain/access"

/** Client-safe DTOs of the dashboard "Share link" dialog. */

export type ShareTarget = { kind: "tube" | "folder"; id: string; name: string }

/** A key whose secret can go into a share link of the target. */
export type ShareKeyOption = {
  id: string
  description: string | null
  role: Role
  roleLabel: string
  /** Restricted to some folders / tubes (else: everything). */
  scoped: boolean
}

export type ShareLink = {
  keyId: string
  url: string
  /** QR code of `url` as an SVG data URI. */
  qr: string
}

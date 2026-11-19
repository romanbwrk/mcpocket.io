import { KeyRoundIcon } from "lucide-react"

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

const COPY = {
  missing: {
    title: "This link is incomplete",
    description:
      "Shared pages need the api_key from the original link. Ask for the full link or scan its QR code again.",
  },
  invalid: {
    title: "This link is no longer valid",
    description:
      "The API key in this link was revoked, rotated or never existed. Ask the owner for a new share link.",
  },
  rate_limited: {
    title: "Too many requests",
    description:
      "This link was used a lot in the last minute. Try again shortly.",
  },
} as const

/** Shown instead of a share page when the `?api_key=` does not authenticate. */
export function ShareDenied({ reason }: { reason: keyof typeof COPY }) {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <KeyRoundIcon />
        </EmptyMedia>
        <EmptyTitle>{COPY[reason].title}</EmptyTitle>
        <EmptyDescription>{COPY[reason].description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

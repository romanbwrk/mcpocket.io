/**
 * `2026-11-15 13:47` (UTC; full ISO in the tooltip) — stable across SSR.
 * `seconds` adds `:ss`.
 */
export function UtcTime({ iso, seconds }: { iso: string; seconds?: boolean }) {
  return (
    <time dateTime={iso} title={iso} className="whitespace-nowrap tabular-nums">
      {iso.slice(0, seconds ? 19 : 16).replace("T", " ")}
    </time>
  )
}

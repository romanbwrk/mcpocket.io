/**
 * Runs once when a Next.js server instance starts (see
 * node_modules/next/dist/docs/01-app/02-guides/instrumentation.md).
 * First seeds empty storage (JSON data directory or SQLite file) when MCPOCKET_SEED_ON_FIRST_START
 * is on (fresh Docker volume), then starts the background workers — lease sweeper (ticket 15) and webhook
 * dispatcher (ticket 17) — on the Node.js runtime only: never on the edge
 * runtime and never while `next build` collects page data.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  if (process.env.NEXT_PHASE === "phase-production-build") return
  const { seedOnFirstStart } = await import("@mcpocket/core/storage/bootstrap")
  const seed = await seedOnFirstStart()
  if (seed.seeded) {
    console.info(
      `[mcpocket] empty storage ${seed.dataDir} seeded from ${seed.seedFile}: ${seed.counts}`
    )
  }
  const { startLeaseSweeper } = await import("@mcpocket/core/services/lease-sweeper")
  const sweeper = startLeaseSweeper()
  if (sweeper) {
    console.info(
      `[mcpocket] lease sweeper running every ${sweeper.intervalMs / 1000}s`
    )
  }
  const { startWebhookDispatcher } =
    await import("@mcpocket/core/services/webhook-dispatcher")
  const dispatcher = startWebhookDispatcher()
  if (dispatcher) {
    console.info(
      `[mcpocket] webhook dispatcher running every ${dispatcher.intervalMs / 1000}s`
    )
  }
}

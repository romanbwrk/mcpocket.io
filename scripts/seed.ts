/**
 * `npm run seed` — resets the configured storage from `mock/seed.json`
 * (override with `SEED_FILE`):
 * - `STORAGE_DRIVER=json`: the data directory (`DATA_DIR`, default `./data`).
 *   A running server keeps its in-memory copy: restart it after seeding.
 * - `STORAGE_DRIVER=sqlite`: the database (`SQLITE_FILE`, default
 *   `<DATA_DIR>/mcpocket.db`). A running server sees the new data at once.
 * - `STORAGE_DRIVER=mongo`: workspace `MCPOCKET_WORKSPACE` (default
 *   `MCPOCKET_SSO_WORKSPACE`, else `default`) of the database `MONGODB_DB` at
 *   `MONGODB_URI`; other workspaces are untouched. A running server sees the
 *   new data at once.
 */
import path from "node:path"

import { storageConfigFromEnv } from "@mcpocket/core/storage"
import { loadSeed, resetStorageData } from "@mcpocket/core/storage/seed"

async function main() {
  const config = storageConfigFromEnv()
  const seedFile = path.resolve(
    process.env.SEED_FILE ?? path.join(process.cwd(), "mock", "seed.json")
  )
  const dataset = await loadSeed(seedFile)
  await resetStorageData(config, dataset)
  const target =
    config.driver === "sqlite"
      ? config.sqliteFile
      : config.driver === "mongo"
        ? `database "${config.mongoDb}" (workspace "${config.mongoWorkspace}")`
        : config.dataDir
  console.log(
    `Seeded ${target} (${config.driver}) from ${path.relative(process.cwd(), seedFile)}: ` +
      `${dataset.folders.length} folders, ${dataset.tubes.length} tubes, ` +
      `${dataset.items.length} items, ${dataset.history.length} history events`
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

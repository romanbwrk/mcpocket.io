/**
 * `npm run migrate:sqlite` — copies every collection of the JSON data
 * directory (`DATA_DIR`, default `./data`) into the SQLite database
 * (`SQLITE_FILE`, default `<DATA_DIR>/mcpocket.db`). The JSON files are left
 * untouched. Refuses to overwrite a non-empty database unless `--force`.
 *
 * Stop the server (still on STORAGE_DRIVER=json) first, run this, then start
 * it with STORAGE_DRIVER=sqlite.
 */
import { storageConfigFromEnv } from "@mcpocket/core/storage"
import { readDataset } from "@mcpocket/core/storage/json/files"
import {
  isSqliteDbEmpty,
  replaceSqliteDataset,
} from "@mcpocket/core/storage/sqlite/dataset"

async function main() {
  const { dataDir, sqliteFile } = storageConfigFromEnv({
    ...process.env,
    STORAGE_DRIVER: "sqlite",
  })
  const force = process.argv.includes("--force")
  if (!force && !isSqliteDbEmpty(sqliteFile)) {
    throw new Error(
      `${sqliteFile} already has data; re-run with --force to replace it`
    )
  }
  const dataset = await readDataset(dataDir)
  replaceSqliteDataset(sqliteFile, dataset)
  const counts = Object.entries(dataset)
    .map(([name, rows]) => `${rows.length} ${name}`)
    .join(", ")
  console.log(`Copied ${dataDir} → ${sqliteFile}: ${counts}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

import { existsSync } from "node:fs"

import type { Dataset } from "../../domain/schemas"

import {
  insertRows,
  openSqliteDatabase,
  TABLES,
  type TableName,
} from "./sqlite-storage"

/** True when the database file is missing or none of its tables has a row. */
export function isSqliteDbEmpty(file: string): boolean {
  if (!existsSync(file)) return true
  const db = openSqliteDatabase(file)
  try {
    return Object.values(TABLES).every(
      ({ table }) => !db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
    )
  } finally {
    db.close()
  }
}

/**
 * Replaces the given collections (default: all) of the database with
 * `dataset`, in one transaction. Safe while a server has the file open:
 * SQLite locks serialise the two processes and the server reads the new rows
 * immediately (unlike the JSON driver, no restart is needed).
 */
export function replaceSqliteDataset(
  file: string,
  dataset: Dataset,
  names: TableName[] = Object.keys(TABLES) as TableName[]
): void {
  const db = openSqliteDatabase(file)
  try {
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const name of names) {
        db.exec(`DELETE FROM ${TABLES[name].table}`)
        insertRows(db, name, dataset[name] as never)
      }
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  } finally {
    db.close()
  }
}

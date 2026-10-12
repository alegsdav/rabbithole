import "server-only";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import path from "node:path";

import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

const globalForDb = globalThis as unknown as { __rabbitholeDb?: Db };

/** Opens (and migrates) a SQLite database; ":memory:" for tests. */
export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  return db;
}

/** The app's database, opened once per process (survives dev hot reloads). */
export function db(): Db {
  if (!globalForDb.__rabbitholeDb) {
    globalForDb.__rabbitholeDb = openDb(process.env.DATABASE_PATH ?? "./data/rabbithole.db");
  }
  return globalForDb.__rabbitholeDb;
}

/** Tests swap in their own database. */
export function setDbForTests(next: Db): void {
  globalForDb.__rabbitholeDb = next;
}

export { schema };

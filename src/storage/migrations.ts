import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

const MIGRATION_FILE_PATTERN = /^\d+[_-].+\.sql$/;
const MIGRATION_LOCK_ID = 824_716_329;

export async function runMigrations(
  pool: Pool,
  migrationsDirectory = path.resolve(process.cwd(), "migrations"),
): Promise<void> {
  const files = (await readdir(migrationsDirectory))
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    throw new Error(`No SQL migrations found in ${migrationsDirectory}`);
  }

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);

    for (const filename of files) {
      const sql = await readFile(path.join(migrationsDirectory, filename), "utf8");
      const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE filename = $1",
        [filename],
      );
      if (existing.rowCount === 1) {
        if (existing.rows[0]!.checksum !== checksum) {
          throw new Error(`Applied migration ${filename} has been modified`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [filename, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

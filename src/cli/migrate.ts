import { closePool, createPool } from "../db/pool.js";
import { loadConfig, loadLocalEnvironment } from "../config.js";
import { runMigrations } from "../storage/migrations.js";

loadLocalEnvironment();
const config = loadConfig();
const pool = createPool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
});

try {
  await runMigrations(pool);
  process.stdout.write("Database migrations are up to date.\n");
} finally {
  await closePool(pool);
}

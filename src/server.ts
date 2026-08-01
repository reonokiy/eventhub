import { buildApp } from "./app.js";
import { loadConfig, loadLocalEnvironment } from "./config.js";
import { ensureBootstrapTenantAndClient } from "./db/bootstrap.js";
import { createDatabase } from "./db/database.js";
import { closePool, createPool } from "./db/pool.js";
import { RetentionWorker } from "./retention/worker.js";
import { startEventHubRuntime } from "./runtime.js";
import { runMigrations } from "./storage/migrations.js";

loadLocalEnvironment();
const config = loadConfig();
await startEventHubRuntime(config, {
  createPool,
  closePool,
  createDatabase,
  runMigrations,
  ensureBootstrapTenantAndClient,
  buildApp,
  createRetentionWorker: (database, logger) => new RetentionWorker(database, logger),
  registerSignal: (signal, listener) => {
    process.once(signal, listener);
  },
  reportError: (...values) => {
    console.error(...values);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

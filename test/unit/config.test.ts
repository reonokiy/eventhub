import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig, loadLocalEnvironment } from "../../src/config.js";

describe("application configuration", () => {
  it("loads safe database timeout and retention defaults", () => {
    const config = loadConfig({});
    assert.equal(config.databaseConnectionTimeoutMs, 5000);
    assert.equal(config.databaseQueryTimeoutMs, 30_000);
    assert.equal(config.databasePoolMax, 10);
    assert.equal(config.eventRetentionDays, 30);
    assert.equal(config.usesInsecureDevelopmentSecrets, true);
  });

  it("loads every supported setting and reports production secrets as safe", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "8080",
      LOG_LEVEL: "debug",
      DATABASE_URL: "postgres://example.invalid/eventhub",
      DATABASE_POOL_MAX: "20",
      DATABASE_CONNECTION_TIMEOUT_MS: "1000",
      DATABASE_QUERY_TIMEOUT_MS: "2000",
      MIGRATE_ON_START: "false",
      BOOTSTRAP_TENANT_ID: "10000000-0000-4000-8000-000000000001",
      BOOTSTRAP_TENANT_NAME: "Production tenant",
      BOOTSTRAP_API_KEY: "production-bootstrap-api-key-with-at-least-32-chars",
      ADMIN_API_KEY: "production-admin-api-key-with-at-least-32-chars",
      BOOTSTRAP_WEBHOOK_CONNECTION_ID: "10000000-0000-4000-8000-000000000002",
      BOOTSTRAP_WEBHOOK_SECRET: "production-webhook-secret",
      EVENT_RETENTION_DAYS: "90",
      MAX_EVENT_BYTES: "4096",
      SSE_BATCH_SIZE: "50",
      SSE_POLL_INTERVAL_MS: "1000",
      SSE_HEARTBEAT_INTERVAL_MS: "5000",
      SSE_WRITE_TIMEOUT_MS: "6000",
      WEBHOOK_MAX_CLOCK_SKEW_SECONDS: "60",
    });

    assert.deepEqual(config, {
      nodeEnv: "production",
      host: "127.0.0.1",
      port: 8080,
      logLevel: "debug",
      databaseUrl: "postgres://example.invalid/eventhub",
      databasePoolMax: 20,
      databaseConnectionTimeoutMs: 1000,
      databaseQueryTimeoutMs: 2000,
      migrateOnStart: false,
      bootstrapTenantId: "10000000-0000-4000-8000-000000000001",
      bootstrapTenantName: "Production tenant",
      bootstrapApiKey: "production-bootstrap-api-key-with-at-least-32-chars",
      adminApiKey: "production-admin-api-key-with-at-least-32-chars",
      bootstrapWebhookConnectionId: "10000000-0000-4000-8000-000000000002",
      bootstrapWebhookSecret: "production-webhook-secret",
      eventRetentionDays: 90,
      maxEventBytes: 4096,
      sseBatchSize: 50,
      ssePollIntervalMs: 1000,
      sseHeartbeatIntervalMs: 5000,
      sseWriteTimeoutMs: 6000,
      webhookMaxClockSkewSeconds: 60,
      usesInsecureDevelopmentSecrets: false,
    });
  });

  it("loads the process environment when no explicit environment is supplied", () => {
    assert.equal(typeof loadConfig().port, "number");
  });

  it("loads an optional local env file and ignores a missing one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eventhub-config-"));
    const path = join(directory, ".env");
    const key = `EVENTHUB_CONFIG_TEST_${process.pid}`;

    try {
      await writeFile(path, `${key}=loaded\n`, "utf8");
      loadLocalEnvironment(path);
      assert.equal(process.env[key], "loaded");
      delete process.env[key];

      assert.doesNotThrow(() => loadLocalEnvironment(join(directory, "missing.env")));
      assert.throws(() => loadLocalEnvironment(directory));
    } finally {
      delete process.env[key];
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reserves capacity for the dedicated LISTEN connection", () => {
    assert.throws(() => loadConfig({ DATABASE_POOL_MAX: "1" }), /between 2 and 100/);
    assert.equal(loadConfig({ DATABASE_POOL_MAX: "2" }).databasePoolMax, 2);
  });

  it("rejects a retention window shorter than the idempotency contract", () => {
    assert.throws(() => loadConfig({ EVENT_RETENTION_DAYS: "29" }), /between 30 and 3650/);
  });

  it("does not allow tuning beyond protocol reliability limits", () => {
    assert.throws(() => loadConfig({ SSE_POLL_INTERVAL_MS: "5001" }), /between 250 and 5000/);
    assert.throws(
      () => loadConfig({ SSE_HEARTBEAT_INTERVAL_MS: "15001" }),
      /between 1000 and 15000/,
    );
    assert.throws(
      () => loadConfig({ WEBHOOK_MAX_CLOCK_SKEW_SECONDS: "301" }),
      /between 0 and 300/,
    );
  });

  it("rejects unusable API keys and weak webhook secrets", () => {
    assert.throws(() => loadConfig({ BOOTSTRAP_API_KEY: "abcd efgh" }), /without spaces/);
    assert.throws(() => loadConfig({ ADMIN_API_KEY: "abcd efgh" }), /without spaces/);
    assert.throws(() => loadConfig({ BOOTSTRAP_WEBHOOK_SECRET: "" }), /at least 16/);
    assert.throws(
      () => loadConfig({ BOOTSTRAP_WEBHOOK_SECRET: "                " }),
      /at least 16/,
    );
  });

  it("does not permit the management credential to also authenticate applications", () => {
    assert.throws(
      () =>
        loadConfig({
          BOOTSTRAP_API_KEY: "shared-api-key",
          ADMIN_API_KEY: "shared-api-key",
        }),
      /must differ/,
    );
  });

  it("rejects generated application keys as the management credential", () => {
    assert.throws(
      () => loadConfig({ ADMIN_API_KEY: "ehk_4AUh3sjALmHWA_WxZLXJGwQb_0WZbVxKuMcn6oVFOJE" }),
      /must not use the ehk_ application API key prefix/,
    );
  });

  it("parses booleans and rejects invalid booleans, UUIDs, and log levels", () => {
    assert.equal(loadConfig({ MIGRATE_ON_START: "true" }).migrateOnStart, true);
    assert.throws(() => loadConfig({ MIGRATE_ON_START: "yes" }), /Expected a boolean value/);
    assert.throws(() => loadConfig({ BOOTSTRAP_TENANT_ID: "not-a-uuid" }), /valid UUID/);
    assert.throws(
      () => loadConfig({ BOOTSTRAP_WEBHOOK_CONNECTION_ID: "not-a-uuid" }),
      /valid UUID/,
    );
    assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }), /LOG_LEVEL is invalid/);
  });

  it("detects either built-in development credential independently", () => {
    const productionSecrets = {
      BOOTSTRAP_API_KEY: "production-api-key",
      ADMIN_API_KEY: "production-admin-api-key",
      BOOTSTRAP_WEBHOOK_SECRET: "production-webhook-secret",
    };
    assert.equal(
      loadConfig({ ...productionSecrets, BOOTSTRAP_API_KEY: "dev-api-key-change-me" })
        .usesInsecureDevelopmentSecrets,
      true,
    );
    assert.equal(
      loadConfig({ ...productionSecrets, BOOTSTRAP_WEBHOOK_SECRET: "dev-webhook-secret-change-me" })
        .usesInsecureDevelopmentSecrets,
      true,
    );
    assert.equal(
      loadConfig({ ...productionSecrets, ADMIN_API_KEY: "dev-admin-api-key-change-me" })
        .usesInsecureDevelopmentSecrets,
      true,
    );
  });

  it("fails closed when production is configured with built-in development credentials", () => {
    const productionSecrets = {
      NODE_ENV: "production",
      BOOTSTRAP_API_KEY: "production-bootstrap-api-key-with-at-least-32-chars",
      ADMIN_API_KEY: "production-admin-api-key-with-at-least-32-chars",
      BOOTSTRAP_WEBHOOK_SECRET: "production-webhook-secret",
    };

    assert.throws(
      () => loadConfig({ ...productionSecrets, BOOTSTRAP_API_KEY: "dev-api-key-change-me" }),
      /NODE_ENV=production must configure non-development credentials for BOOTSTRAP_API_KEY/,
    );
    assert.throws(
      () =>
        loadConfig({
          ...productionSecrets,
          ADMIN_API_KEY: "dev-admin-api-key-change-me",
        }),
      /NODE_ENV=production must configure non-development credentials for ADMIN_API_KEY/,
    );
    assert.throws(
      () =>
        loadConfig({
          ...productionSecrets,
          BOOTSTRAP_WEBHOOK_SECRET: "dev-webhook-secret-change-me",
        }),
      /NODE_ENV=production must configure non-development credentials for BOOTSTRAP_WEBHOOK_SECRET/,
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: "production" }),
      /BOOTSTRAP_API_KEY, ADMIN_API_KEY, BOOTSTRAP_WEBHOOK_SECRET/,
    );
  });

  it("requires production API credentials to be at least 32 characters", () => {
    const productionSecrets = {
      NODE_ENV: "production",
      BOOTSTRAP_API_KEY: "production-bootstrap-api-key-with-at-least-32-chars",
      ADMIN_API_KEY: "production-admin-api-key-with-at-least-32-chars",
      BOOTSTRAP_WEBHOOK_SECRET: "production-webhook-secret",
    };

    assert.throws(
      () => loadConfig({ ...productionSecrets, BOOTSTRAP_API_KEY: "too-short-bootstrap-key" }),
      /NODE_ENV=production requires BOOTSTRAP_API_KEY to contain at least 32/,
    );
    assert.throws(
      () => loadConfig({ ...productionSecrets, ADMIN_API_KEY: "too-short-admin-key" }),
      /NODE_ENV=production requires ADMIN_API_KEY to contain at least 32/,
    );
  });
});

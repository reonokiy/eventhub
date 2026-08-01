import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { buildApp } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { provisionApiClient } from "../../src/db/api-clients.js";
import { createDatabase, type Database } from "../../src/db/database.js";
import type { EventNotifier, WakeReason } from "../../src/realtime/notifier.js";
import { EventHubClient, MemoryCursorStore } from "../../src/sdk/index.js";
import { runMigrations } from "../../src/storage/migrations.js";

const testDatabaseUrl = process.env.EVENTHUB_TEST_DATABASE_URL?.trim() || undefined;

describe(
  "TypeScript SDK against EventHub over PostgreSQL and HTTP",
  {
    skip:
      testDatabaseUrl === undefined
        ? "set EVENTHUB_TEST_DATABASE_URL to run PostgreSQL integration tests"
        : false,
  },
  () => {
    let pool: Pool | undefined;
    let database: Database | undefined;

    before(async () => {
      assert.ok(testDatabaseUrl, "EVENTHUB_TEST_DATABASE_URL must be set for this suite");
      pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
      database = createDatabase(pool);
      await runMigrations(pool);
    });

    after(async () => {
      await pool?.end();
    });

    it("publishes, lists, subscribes, and persists a cursor only after processing", async () => {
      const pgPool = requirePool(pool);
      const orm = requireDatabase(database);
      const tenantId = randomUUID();
      let app: FastifyInstance | undefined;

      await pgPool.query(
        "INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'SDK end-to-end tenant')",
        [tenantId, `sdk-e2e-${tenantId}`],
      );

      try {
        const writer = await provisionApiClient(
          { tenantId, name: "sdk-writer", scopes: ["events:write"] },
          orm,
        );
        const reader = await provisionApiClient(
          { tenantId, name: "sdk-reader", scopes: ["events:read"] },
          orm,
        );

        app = await buildApp({
          config: e2eConfig(requireTestDatabaseUrl()),
          pool: pgPool,
          database: orm,
          notifier: new DelayedPollingNotifier(),
        });
        const address = await app.listen({ host: "127.0.0.1", port: 0 });
        const producer = new EventHubClient({ baseUrl: address, apiKey: writer.apiKey });
        const consumer = new EventHubClient({ baseUrl: address, apiKey: reader.apiKey });

        const published = await producer.publish(
          {
            specversion: "1.0",
            id: "invoice-42-created",
            source: "urn:test:sdk-e2e",
            type: "com.example.invoice.created.v1",
            datacontenttype: "application/json",
            eventhubstream: "invoices",
            data: { invoiceId: "42", amountCents: 4200 },
          },
          { idempotencyKey: "invoice-42-created" },
        );
        assert.equal(published.event.eventhuboffset, "1");
        assert.equal(published.idempotentReplay, false);

        const page = await consumer.list({ after: "0", stream: "invoices" });
        assert.equal(page.events.length, 1);
        assert.equal(page.events[0]?.id, "invoice-42-created");
        assert.equal(page.page.next_after, "1");

        const cursorStore = new MemoryCursorStore();
        const abortController = new AbortController();
        const received: string[] = [];
        await consumer.consume({
          cursorStore,
          initialCursor: "0",
          stream: "invoices",
          signal: abortController.signal,
          onEvent: async (event) => {
            received.push(event.id);
            abortController.abort();
          },
        });
        assert.deepEqual(received, ["invoice-42-created"]);
        assert.equal(await cursorStore.load(), "1");
      } finally {
        try {
          await app?.close();
        } finally {
          await pgPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
        }
      }
    });
  },
);

class DelayedPollingNotifier implements EventNotifier {
  public async waitForTenant(
    _tenantId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WakeReason> {
    try {
      await delay(timeoutMs, undefined, { signal, ref: false });
      return "poll";
    } catch {
      return "aborted";
    }
  }
}

function e2eConfig(databaseUrl: string): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.EVENTHUB_TEST_LOG_LEVEL ?? "silent",
    DATABASE_URL: databaseUrl,
    SSE_POLL_INTERVAL_MS: "250",
    SSE_HEARTBEAT_INTERVAL_MS: "1000",
    SSE_WRITE_TIMEOUT_MS: "2000",
  });
}

function requirePool(pool: Pool | undefined): Pool {
  assert.ok(pool, "PostgreSQL pool must be initialized by the suite hook");
  return pool;
}

function requireDatabase(database: Database | undefined): Database {
  assert.ok(database, "Database must be initialized by the suite hook");
  return database;
}

function requireTestDatabaseUrl(): string {
  assert.ok(testDatabaseUrl, "EVENTHUB_TEST_DATABASE_URL must be set for this suite");
  return testDatabaseUrl;
}

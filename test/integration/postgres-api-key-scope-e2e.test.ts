import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { buildApp } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { provisionApiClient } from "../../src/db/api-clients.js";
import { createDatabase, type Database } from "../../src/db/database.js";
import type { EventNotifier, WakeReason } from "../../src/realtime/notifier.js";
import { runMigrations } from "../../src/storage/migrations.js";

const testDatabaseUrl = process.env.EVENTHUB_TEST_DATABASE_URL?.trim() || undefined;

describe(
  "per-application API-key scopes end to end",
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

    it("keeps write-only and read-only application credentials isolated over HTTP", async () => {
      const pgPool = requirePool(pool);
      const orm = requireDatabase(database);
      const tenantId = randomUUID();
      let app: FastifyInstance | undefined;

      await pgPool.query(
        "INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'API-key scope E2E tenant')",
        [tenantId, `api-key-scope-e2e-${tenantId}`],
      );

      try {
        const writer = await provisionApiClient(
          {
            tenantId,
            name: "orders-publisher",
            scopes: ["events:write"],
          },
          orm,
        );
        const reader = await provisionApiClient(
          {
            tenantId,
            name: "orders-consumer",
            scopes: ["events:read"],
          },
          orm,
        );
        assert.notEqual(writer.apiKey, reader.apiKey);

        const storedScopes = await pgPool.query<{ name: string; scopes: string[] }>(
          "SELECT name, scopes FROM api_clients WHERE id = ANY($1::uuid[]) ORDER BY name",
          [[reader.id, writer.id]],
        );
        assert.deepEqual(storedScopes.rows, [
          { name: "orders-consumer", scopes: ["events:read"] },
          { name: "orders-publisher", scopes: ["events:write"] },
        ]);

        app = await buildApp({
          config: e2eConfig(requireTestDatabaseUrl()),
          pool: pgPool,
          database: orm,
          notifier: new PollingNotifier(),
        });
        const address = await app.listen({ host: "127.0.0.1", port: 0 });

        const published = await fetch(`${address}/v1/events`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${writer.apiKey}`,
            "content-type": "application/cloudevents+json",
          },
          body: JSON.stringify({
            specversion: "1.0",
            id: "order-1001",
            source: "urn:test:api-key-scope-e2e",
            type: "com.example.orders.created.v1",
            datacontenttype: "application/json",
            eventhubstream: "orders",
            data: { orderId: "1001", totalCents: 4200 },
          }),
        });
        const publishedBody = await readJson<PublicCloudEvent>(published);
        assert.equal(published.status, 201);
        assert.equal(publishedBody.id, "order-1001");
        assert.equal(publishedBody.eventhuboffset, "1");

        const writerList = await fetch(`${address}/v1/events?after=0`, {
          headers: { authorization: `Bearer ${writer.apiKey}` },
        });
        const writerListProblem = await readJson<ProblemDetail>(writerList);
        assert.equal(writerList.status, 403);
        assert.equal(writerListProblem.code, "forbidden");

        const readerPublish = await fetch(`${address}/v1/events`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${reader.apiKey}`,
            "content-type": "application/cloudevents+json",
          },
          body: JSON.stringify({
            specversion: "1.0",
            id: "order-1002",
            source: "urn:test:api-key-scope-e2e",
            type: "com.example.orders.created.v1",
            eventhubstream: "orders",
            data: { orderId: "1002" },
          }),
        });
        const readerPublishProblem = await readJson<ProblemDetail>(readerPublish);
        assert.equal(readerPublish.status, 403);
        assert.equal(readerPublishProblem.code, "forbidden");

        const readerList = await fetch(`${address}/v1/events?after=0`, {
          headers: { authorization: `Bearer ${reader.apiKey}` },
        });
        const readerListBody = await readJson<EventListResponse>(readerList);
        assert.equal(readerList.status, 200);
        assert.equal(readerListBody.events.length, 1);
        const listed = readerListBody.events[0];
        assert.ok(listed, "read-only client must receive the writer's event");
        assert.equal(listed.specversion, "1.0");
        assert.equal(listed.id, "order-1001");
        assert.equal(listed.source, "urn:test:api-key-scope-e2e");
        assert.equal(listed.type, "com.example.orders.created.v1");
        assert.equal(listed.datacontenttype, "application/json");
        assert.equal(listed.eventhubstream, "orders");
        assert.equal(listed.eventhuboffset, "1");
        assert.match(listed.eventhubreceivedat, /^\d{4}-\d{2}-\d{2}T/);
        assert.deepEqual(listed.data, { orderId: "1001", totalCents: 4200 });
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

class PollingNotifier implements EventNotifier {
  public async waitForTenant(
    _tenantId: string,
    _timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WakeReason> {
    return signal?.aborted === true ? "aborted" : "poll";
  }
}

interface PublicCloudEvent {
  readonly specversion: string;
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly datacontenttype: string;
  readonly eventhubstream: string;
  readonly eventhuboffset: string;
  readonly eventhubreceivedat: string;
  readonly data: unknown;
}

interface EventListResponse {
  readonly events: readonly PublicCloudEvent[];
}

interface ProblemDetail {
  readonly code: string;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
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

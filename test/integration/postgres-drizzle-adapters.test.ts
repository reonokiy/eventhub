import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Pool } from "pg";

import { authenticateApiKeyValue } from "../../src/db/auth.js";
import { ensureBootstrapTenantAndClient } from "../../src/db/bootstrap.js";
import { getSourceConnection } from "../../src/db/connections.js";
import { createDatabase, type Database } from "../../src/db/database.js";
import { appendEvent, listEvents } from "../../src/db/events.js";
import { PostgresNotifier, type NotifierLogger } from "../../src/realtime/notifier.js";
import { runMigrations } from "../../src/storage/migrations.js";

const testDatabaseUrl = process.env.EVENTHUB_TEST_DATABASE_URL?.trim() || undefined;

describe(
  "Drizzle PostgreSQL adapters",
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

    it("round-trips offsets above the JavaScript safe integer limit", async () => {
      const pgPool = requirePool(pool);
      const orm = requireDatabase(database);
      await withTestTenant(pgPool, async (tenantId) => {
        const previousOffset = 9_007_199_254_740_992n;
        await pgPool.query(
          "INSERT INTO tenant_heads (tenant_id, last_offset) VALUES ($1, $2)",
          [tenantId, previousOffset.toString()],
        );

        const appended = await appendEvent(
          {
            tenantId,
            stream: "precision",
            id: "large-offset",
            source: "urn:test:precision",
            type: "com.example.precision.v1",
            data: { exact: true },
          },
          orm,
        );
        assert.equal(appended.event.offset, "9007199254740993");

        const page = await listEvents(
          {
            tenantId,
            after: previousOffset,
            highWaterMark: previousOffset + 1n,
          },
          orm,
        );
        assert.equal(page.highWaterMark, "9007199254740993");
        assert.equal(page.events[0]?.offset, "9007199254740993");
      });
    });

    it("keeps bootstrap, API-key auth, and source lookup idempotent", async () => {
      const pgPool = requirePool(pool);
      const orm = requireDatabase(database);
      const tenantId = randomUUID();
      const connectionId = randomUUID();
      const apiKey = `integration-${randomUUID()}`;
      const options = {
        tenantId,
        tenantSlug: `adapter-${tenantId}`,
        tenantName: "Drizzle adapter tenant",
        apiKey,
        webhook: {
          id: connectionId,
          secret: "adapter-webhook-secret",
          provider: "hmac",
          name: "adapter-hmac",
          stream: "adapter-events",
        },
      } as const;

      try {
        const first = await ensureBootstrapTenantAndClient(options, orm);
        const second = await ensureBootstrapTenantAndClient(options, orm);
        assert.equal(second.apiClient.id, first.apiClient.id);
        assert.equal(second.sourceConnectionId, connectionId);

        const principal = await authenticateApiKeyValue(apiKey, orm);
        assert.equal(principal?.tenantId, tenantId);
        assert.deepEqual(principal?.scopes, ["events:read", "events:write"]);

        const connection = await getSourceConnection("hmac", connectionId, orm);
        assert.equal(connection?.tenantId, tenantId);
        assert.equal(connection?.stream, "adapter-events");
        assert.equal(connection?.signingSecret, "adapter-webhook-secret");

        const lastUsed = await pgPool.query<{ last_used_at: Date | null }>(
          "SELECT last_used_at FROM api_clients WHERE id = $1",
          [first.apiClient.id],
        );
        assert.ok(lastUsed.rows[0]?.last_used_at instanceof Date);
      } finally {
        await pgPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
      }
    });

    it("delivers committed NOTIFY wakeups only to the matching tenant", async () => {
      const pgPool = requirePool(pool);
      await withTestTenant(pgPool, async (tenantId) => {
        await withTestTenant(pgPool, async (otherTenantId) => {
          const notifier = new PostgresNotifier(pgPool, silentLogger);
          const client = await pgPool.connect();
          let transactionOpen = false;
          try {
            await notifier.start();
            await client.query("BEGIN");
            transactionOpen = true;
            await appendEvent(
              {
                tenantId,
                stream: "notifications",
                id: "transactional-notify",
                source: "urn:test:notifications",
                type: "com.example.notification.v1",
                data: null,
              },
              createDatabase(client),
            );

            assert.equal(await notifier.waitForTenant(tenantId, 150), "poll");

            const matchingWake = notifier.waitForTenant(tenantId, 2000);
            const unrelatedWake = notifier.waitForTenant(otherTenantId, 250);
            await client.query("COMMIT");
            transactionOpen = false;

            assert.equal(await matchingWake, "notification");
            assert.equal(await unrelatedWake, "poll");
          } finally {
            if (transactionOpen) {
              await client.query("ROLLBACK").catch(() => undefined);
            }
            client.release();
            await notifier.stop();
          }
        });
      });
    });
  },
);

const silentLogger: NotifierLogger = {
  info() {},
  warn() {},
  error() {},
};

async function withTestTenant(
  database: Pool,
  run: (tenantId: string) => Promise<void>,
): Promise<void> {
  const tenantId = randomUUID();
  await database.query(
    "INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Drizzle integration tenant')",
    [tenantId, `drizzle-test-${tenantId}`],
  );
  try {
    await run(tenantId);
  } finally {
    await database.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  }
}

function requirePool(pool: Pool | undefined): Pool {
  assert.ok(pool, "PostgreSQL pool must be initialized by the suite hook");
  return pool;
}

function requireDatabase(database: Database | undefined): Database {
  assert.ok(database, "Drizzle database must be initialized by the suite hook");
  return database;
}


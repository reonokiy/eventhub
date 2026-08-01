import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Pool } from "pg";

import {
  appendEvent,
  EventIdentityConflictError,
  hashIdempotencyKey,
  IdempotencyKeyConflictError,
  listEvents,
} from "../../src/db/events.js";
import { createDatabase, type Database } from "../../src/db/database.js";
import type { AppendEventResult, PublishIdempotency } from "../../src/db/types.js";
import type { JsonValue } from "../../src/domain/json.js";
import { runMigrations } from "../../src/storage/migrations.js";

const testDatabaseUrl = process.env.EVENTHUB_TEST_DATABASE_URL?.trim() || undefined;

describe(
  "PostgreSQL event log integration",
  {
    skip:
      testDatabaseUrl === undefined
        ? "set EVENTHUB_TEST_DATABASE_URL to run PostgreSQL integration tests"
        : false,
  },
  () => {
    let pool: Pool | undefined;

    before(async () => {
      assert.ok(testDatabaseUrl, "EVENTHUB_TEST_DATABASE_URL must be set for this suite");
      pool = new Pool({ connectionString: testDatabaseUrl, max: 16 });
      await runMigrations(pool);
    });

    after(async () => {
      await pool?.end();
    });

    it("allocates every offset exactly once under concurrent appends", async () => {
      const database = requirePool(pool);
      const orm = createDatabase(database);
      await withTestTenant(database, async (tenantId) => {
        const count = 48;
        const results = await Promise.all(
          Array.from({ length: count }, (_, index) =>
            appendFixture(orm, tenantId, {
              id: `concurrent-${index}`,
              source: "urn:test:concurrency",
              type: "com.example.concurrent.v1",
              stream: "engineering",
              data: { index },
            }),
          ),
        );

        const offsets = results
          .map((result) => Number(result.event.offset))
          .sort((left, right) => left - right);
        assert.deepEqual(
          offsets,
          Array.from({ length: count }, (_, index) => index + 1),
        );
        assert.ok(results.every((result) => result.inserted));
        assert.ok(results.every((result) => result.replayReason === null));

        const stored = await database.query<{
          count: string;
          minimum: string;
          maximum: string;
          last_offset: string;
        }>(
          `SELECT count(e.*)::text AS count,
                  min(e."offset")::text AS minimum,
                  max(e."offset")::text AS maximum,
                  h.last_offset::text AS last_offset
             FROM tenant_heads AS h
             JOIN events AS e ON e.tenant_id = h.tenant_id
            WHERE h.tenant_id = $1
         GROUP BY h.last_offset`,
          [tenantId],
        );
        assert.deepEqual(stored.rows[0], {
          count: String(count),
          minimum: "1",
          maximum: String(count),
          last_offset: String(count),
        });
      });
    });

    it("keeps offsets and replay results isolated between tenants", async () => {
      const database = requirePool(pool);
      const orm = createDatabase(database);
      await withTestTenant(database, async (firstTenantId) => {
        await withTestTenant(database, async (secondTenantId) => {
          const commonIdentity = {
            source: "urn:test:shared-provider",
            type: "com.example.shared.v1",
            stream: "default",
          } as const;
          const first = await appendFixture(orm, firstTenantId, {
            ...commonIdentity,
            id: "same-provider-id",
            data: { tenant: "first" },
          });
          const second = await appendFixture(orm, secondTenantId, {
            ...commonIdentity,
            id: "same-provider-id",
            data: { tenant: "second" },
          });

          assert.equal(first.event.offset, "1");
          assert.equal(second.event.offset, "1");

          const firstReplay = await listEvents({ tenantId: firstTenantId }, orm);
          const secondReplay = await listEvents({ tenantId: secondTenantId }, orm);
          assert.deepEqual(firstReplay.events.map((event) => event.data), [{ tenant: "first" }]);
          assert.deepEqual(secondReplay.events.map((event) => event.data), [{ tenant: "second" }]);
        });
      });
    });

    it("deduplicates concurrent provider retries by tenant, source, and event id", async () => {
      const database = requirePool(pool);
      const orm = createDatabase(database);
      await withTestTenant(database, async (tenantId) => {
        const fixture = {
          id: "provider-delivery-42",
          source: "urn:test:provider",
          type: "com.example.created.v1",
          stream: "default",
          data: { delivery: 42 },
        } as const;
        const attempts = await Promise.all(
          Array.from({ length: 20 }, () => appendFixture(orm, tenantId, fixture)),
        );

        assert.equal(attempts.filter((result) => result.inserted).length, 1);
        assert.ok(attempts.every((result) => result.event.offset === "1"));
        assert.ok(attempts.every((result) => result.event.id === "provider-delivery-42"));
        assert.equal(
          attempts.filter((result) => result.replayReason === "event_identity").length,
          19,
        );

        await assert.rejects(
          () => appendFixture(orm, tenantId, { ...fixture, data: { delivery: 43 } }),
          EventIdentityConflictError,
        );

        const stored = await database.query<{ event_count: string; last_offset: string }>(
          `SELECT count(e.*)::text AS event_count,
                  h.last_offset::text AS last_offset
             FROM tenant_heads AS h
        LEFT JOIN events AS e ON e.tenant_id = h.tenant_id
            WHERE h.tenant_id = $1
         GROUP BY h.last_offset`,
          [tenantId],
        );
        assert.deepEqual(stored.rows[0], { event_count: "1", last_offset: "1" });
      });
    });

    it("replays an identical Idempotency-Key request and rejects a changed request", async () => {
      const database = requirePool(pool);
      const orm = createDatabase(database);
      await withTestTenant(database, async (tenantId) => {
        const apiClientId = await createTestApiClient(database, tenantId);
        const idempotency: PublishIdempotency = {
          apiClientId,
          keyHash: hashIdempotencyKey("publish-request-42"),
          requestHash: "b".repeat(64),
        };
        const fixture = {
          id: "event-with-idempotency-key",
          source: "urn:test:publisher",
          type: "com.example.published.v1",
          stream: "default",
          data: { value: 42 },
          idempotency,
        } as const;

        const inserted = await appendFixture(orm, tenantId, fixture);
        const replayed = await appendFixture(orm, tenantId, fixture);

        assert.equal(inserted.inserted, true);
        assert.equal(inserted.replayReason, null);
        assert.equal(replayed.inserted, false);
        assert.equal(replayed.replayReason, "idempotency_key");
        assert.equal(replayed.event.offset, inserted.event.offset);

        await assert.rejects(
          () =>
            appendFixture(orm, tenantId, {
              ...fixture,
              id: "different-event",
              data: { value: 43 },
              idempotency: { ...idempotency, requestHash: "c".repeat(64) },
            }),
          IdempotencyKeyConflictError,
        );
      });
    });

    it("rolls back offset allocation together with a failed append transaction", async () => {
      const database = requirePool(pool);
      const orm = createDatabase(database);
      await withTestTenant(database, async (tenantId) => {
        const client = await database.connect();
        try {
          await client.query("BEGIN");
          const rolledBack = await appendFixture(createDatabase(client), tenantId, {
            id: "rolled-back",
            source: "urn:test:rollback",
            type: "com.example.rollback.v1",
            stream: "default",
            data: null,
          });
          assert.equal(rolledBack.event.offset, "1");
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }

        const committed = await appendFixture(orm, tenantId, {
          id: "committed",
          source: "urn:test:rollback",
          type: "com.example.committed.v1",
          stream: "default",
          data: null,
        });
        assert.equal(committed.event.offset, "1");
      });
    });

    it("replays filtered history in order against a stable high-water mark", async () => {
      const database = requirePool(pool);
      const orm = createDatabase(database);
      await withTestTenant(database, async (tenantId) => {
        const fixtures = [
          ["one", "engineering", "com.example.opened.v1"],
          ["two", "sales", "com.example.opened.v1"],
          ["three", "engineering", "com.example.closed.v1"],
          ["four", "engineering", "com.example.opened.v1"],
          ["five", "engineering", "com.example.opened.v1"],
        ] as const;
        for (const [id, stream, type] of fixtures) {
          await appendFixture(orm, tenantId, {
            id,
            source: "urn:test:replay",
            type,
            stream,
            data: { id },
          });
        }

        const firstPage = await listEvents(
          {
            tenantId,
            after: 0n,
            stream: "engineering",
            type: "com.example.opened.v1",
            limit: 2,
          },
          orm,
        );
        assert.deepEqual(
          firstPage.events.map((event) => [event.offset, event.id]),
          [
            ["1", "one"],
            ["4", "four"],
          ],
        );
        assert.deepEqual(
          {
            nextAfter: firstPage.nextAfter,
            highWaterMark: firstPage.highWaterMark,
            hasMore: firstPage.hasMore,
          },
          { nextAfter: "4", highWaterMark: "5", hasMore: true },
        );

        const exactPage = await listEvents(
          {
            tenantId,
            after: 0n,
            stream: "sales",
            limit: 1,
          },
          orm,
        );
        assert.deepEqual(
          {
            events: exactPage.events.map((event) => event.offset),
            nextAfter: exactPage.nextAfter,
            highWaterMark: exactPage.highWaterMark,
            hasMore: exactPage.hasMore,
          },
          {
            events: ["2"],
            nextAfter: "5",
            highWaterMark: "5",
            hasMore: false,
          },
        );

        await appendFixture(orm, tenantId, {
          id: "six",
          source: "urn:test:replay",
          type: "com.example.opened.v1",
          stream: "engineering",
          data: { id: "six" },
        });

        const secondPage = await listEvents(
          {
            tenantId,
            after: firstPage.nextAfter,
            highWaterMark: firstPage.highWaterMark,
            stream: "engineering",
            type: "com.example.opened.v1",
            limit: 2,
          },
          orm,
        );
        assert.deepEqual(
          secondPage.events.map((event) => [event.offset, event.id]),
          [["5", "five"]],
        );
        assert.deepEqual(
          {
            nextAfter: secondPage.nextAfter,
            highWaterMark: secondPage.highWaterMark,
            hasMore: secondPage.hasMore,
          },
          { nextAfter: "5", highWaterMark: "5", hasMore: false },
        );

        const freshReplay = await listEvents(
          {
            tenantId,
            after: secondPage.nextAfter,
            stream: "engineering",
            type: "com.example.opened.v1",
            limit: 2,
          },
          orm,
        );
        assert.deepEqual(
          freshReplay.events.map((event) => [event.offset, event.id]),
          [["6", "six"]],
        );
      });
    });
  },
);

interface AppendFixture {
  readonly stream: string;
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly data: JsonValue;
  readonly idempotency?: PublishIdempotency;
}

function appendFixture(
  database: Database,
  tenantId: string,
  event: AppendFixture,
): Promise<AppendEventResult> {
  return appendEvent(
    {
      tenantId,
      stream: event.stream,
      id: event.id,
      source: event.source,
      type: event.type,
      data: event.data,
      ...(event.idempotency === undefined ? {} : { idempotency: event.idempotency }),
    },
    database,
  );
}

async function createTestApiClient(database: Pool, tenantId: string): Promise<string> {
  const id = randomUUID();
  const keyHash = hashIdempotencyKey(randomUUID());
  await database.query(
    `INSERT INTO api_clients (id, tenant_id, name, key_prefix, key_hash)
     VALUES ($1, $2, $3, 'test', $4)`,
    [id, tenantId, `Integration client ${id}`, keyHash],
  );
  return id;
}

async function withTestTenant(
  database: Pool,
  run: (tenantId: string) => Promise<void>,
): Promise<void> {
  const tenantId = randomUUID();
  const slug = `test-${tenantId}`;
  await database.query(
    "INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Integration test tenant')",
    [tenantId, slug],
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

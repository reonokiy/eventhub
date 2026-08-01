import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Pool } from "pg";

import { authenticateApiKeyValue } from "../../src/db/auth.js";
import { ensureBootstrapTenantAndClient } from "../../src/db/bootstrap.js";
import { getSourceConnection } from "../../src/db/connections.js";
import { createDatabase, type Database } from "../../src/db/database.js";
import {
  appendEvent,
  getEventByOffset,
  getTenantEventBounds,
  getTenantHighWaterMark,
  listEvents,
} from "../../src/db/events.js";
import type { CloudEvent } from "../../src/domain/cloud-event.js";
import type { JsonValue } from "../../src/domain/json.js";
import {
  PostgresApiClientAuthenticator,
  PostgresSourceConnectionStore,
} from "../../src/storage/postgres-auth.js";
import { PostgresEventStore } from "../../src/storage/postgres-event-store.js";
import { runMigrations } from "../../src/storage/migrations.js";

const testDatabaseUrl = process.env.EVENTHUB_TEST_DATABASE_URL?.trim() || undefined;

describe(
  "PostgreSQL storage coverage",
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

    it("round-trips bootstrap, authentication, and source-connection states", async () => {
      const pg = requirePool(pool);
      const orm = requireDatabase(database);
      const firstTenantId = randomUUID();
      const secondTenantId = randomUUID();
      const connectionId = randomUUID();
      const nullSecretConnectionId = randomUUID();
      const apiKey = `coverage-${randomUUID()}`;
      const secondApiKey = `coverage-${randomUUID()}`;

      try {
        const first = await ensureBootstrapTenantAndClient(
          {
            tenantId: firstTenantId,
            tenantSlug: `coverage-${firstTenantId}`,
            tenantName: "Coverage tenant one",
            retentionDays: 45,
            apiKey,
            apiClientName: "coverage-client",
            scopes: ["events:read", "events:write"],
            webhook: {
              id: connectionId,
              secret: "coverage-webhook-secret-one",
              provider: "github",
              name: "coverage-github",
              stream: "github-events",
              config: { organization: "example" },
            },
          },
          orm,
        );
        assert.equal(first.sourceConnectionId, connectionId);
        assert.equal(first.apiClient.expiresAt, null);

        const updated = await ensureBootstrapTenantAndClient(
          {
            tenantId: firstTenantId,
            tenantSlug: `coverage-${firstTenantId}`,
            tenantName: "Coverage tenant one updated",
            retentionDays: 60,
            apiKey,
            apiClientName: "coverage-client",
            scopes: ["events:read"],
            webhook: {
              id: connectionId,
              secret: "coverage-webhook-secret-two",
              provider: "hmac",
              name: "coverage-hmac",
              stream: "orders",
              config: { version: 2 },
            },
          },
          orm,
        );
        assert.equal(updated.apiClient.id, first.apiClient.id);

        const principal = await authenticateApiKeyValue(apiKey, orm);
        assert.deepEqual(principal?.scopes, ["events:read"]);
        const adapterPrincipal = await new PostgresApiClientAuthenticator(orm).findActiveClientByKeyHash(
          createHash("sha256").update(apiKey, "utf8").digest("hex"),
        );
        assert.equal(adapterPrincipal?.tenantId, firstTenantId);
        assert.equal(
          await new PostgresApiClientAuthenticator(orm).findActiveClientByKeyHash("f".repeat(64)),
          undefined,
        );

        const connection = await getSourceConnection("hmac", connectionId, orm);
        assert.deepEqual(
          connection === null
            ? null
            : {
                stream: connection.stream,
                secret: connection.signingSecret,
                config: connection.config,
              },
          {
            stream: "orders",
            secret: "coverage-webhook-secret-two",
            config: { version: 2 },
          },
        );
        assert.equal(await getSourceConnection("github", connectionId, orm), null);

        await pg.query(
          `INSERT INTO source_connections
             (id, tenant_id, provider, name, stream, signing_secret, config, checkpoint)
           VALUES ($1, $2, 'hmac', 'without-secret', 'no-secret', NULL, '{}', '42')`,
          [nullSecretConnectionId, firstTenantId],
        );
        const connectionStore = new PostgresSourceConnectionStore(orm);
        assert.deepEqual(
          await connectionStore.findActiveConnection("hmac", nullSecretConnectionId),
          {
            id: nullSecretConnectionId,
            tenantId: firstTenantId,
            provider: "hmac",
            stream: "no-secret",
          },
        );
        await pg.query("UPDATE source_connections SET active = false WHERE id = $1", [
          nullSecretConnectionId,
        ]);
        assert.equal(
          await connectionStore.findActiveConnection("hmac", nullSecretConnectionId),
          undefined,
        );

        await ensureBootstrapTenantAndClient(
          {
            tenantId: secondTenantId,
            tenantSlug: `coverage-${secondTenantId}`,
            tenantName: "Coverage tenant two",
            apiKey: secondApiKey,
          },
          orm,
        );
        await assert.rejects(
          () =>
            ensureBootstrapTenantAndClient(
              {
                tenantId: secondTenantId,
                tenantSlug: `coverage-${secondTenantId}`,
                tenantName: "Coverage tenant two",
                apiKey: secondApiKey,
                webhook: {
                  id: connectionId,
                  secret: "coverage-cross-tenant-secret",
                },
              },
              orm,
            ),
          /Bootstrap webhook connection ID belongs to another tenant/,
        );

        await pg.query("UPDATE api_clients SET expires_at = clock_timestamp() - interval '1 day' WHERE id = $1", [
          first.apiClient.id,
        ]);
        assert.equal(await authenticateApiKeyValue(apiKey, orm), null);
        await pg.query("UPDATE api_clients SET expires_at = NULL, revoked_at = clock_timestamp() WHERE id = $1", [
          first.apiClient.id,
        ]);
        assert.equal(await authenticateApiKeyValue(apiKey, orm), null);
      } finally {
        await pg.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
          [firstTenantId, secondTenantId],
        ]);
      }
    });

    it("exercises the event store against real append, replay, query, and cursor SQL", async () => {
      const pg = requirePool(pool);
      const orm = requireDatabase(database);
      const tenantId = randomUUID();
      const apiKey = `coverage-${randomUUID()}`;

      try {
        const bootstrap = await ensureBootstrapTenantAndClient(
          {
            tenantId,
            tenantSlug: `coverage-events-${tenantId}`,
            tenantName: "Coverage event tenant",
            apiKey,
          },
          orm,
        );
        const store = new PostgresEventStore(orm, 45);
        const richEvent: CloudEvent = {
          specversion: "1.0",
          id: "rich-event",
          source: "urn:test:storage-coverage",
          type: "com.example.rich.v1",
          subject: "subject-1",
          time: "2026-08-01T10:20:30+02:00",
          datacontenttype: "application/json; charset=utf-8",
          dataschema: "https://example.test/schemas/rich",
          eventhubstream: "orders",
          traceid: "trace-1",
          data: { amount: 42 },
        };
        const richCommand = {
          tenantId,
          event: richEvent,
          requestHash: "a".repeat(64),
        } as const;
        const inserted = await store.append(richCommand);
        assert.equal(inserted.status, "inserted");
        assert.equal(inserted.storedEvent?.event.subject, "subject-1");
        assert.equal(inserted.storedEvent?.event.time, "2026-08-01T08:20:30.000Z");
        assert.equal(inserted.storedEvent?.event.dataschema, richEvent.dataschema);
        assert.equal(inserted.storedEvent?.event.traceid, "trace-1");
        assert.equal((await store.append(richCommand)).status, "duplicate");

        assert.deepEqual(
          await store.append({
            ...richCommand,
            event: { ...richEvent, data: { amount: 43 } },
            requestHash: "b".repeat(64),
          }),
          { status: "identity_conflict" },
        );

        const idempotentEvent = eventFixture("idempotent-event", "payments", { amount: 9 });
        const idempotentCommand = {
          tenantId,
          event: idempotentEvent,
          requestHash: "c".repeat(64),
          apiClientId: bootstrap.apiClient.id,
          idempotencyKey: "coverage-idempotency-key",
        } as const;
        assert.equal((await store.append(idempotentCommand)).status, "inserted");
        assert.equal((await store.append(idempotentCommand)).status, "duplicate");
        assert.deepEqual(
          await store.append({
            ...idempotentCommand,
            event: eventFixture("changed-request", "payments", { amount: 10 }),
            requestHash: "d".repeat(64),
          }),
          { status: "idempotency_conflict" },
        );

        const apiOnly = await store.append({
          tenantId,
          event: eventFixture("api-only", "orders", null),
          requestHash: "e".repeat(64),
          apiClientId: bootstrap.apiClient.id,
        });
        assert.equal(apiOnly.status, "inserted");
        const keyOnly = await store.append({
          tenantId,
          event: eventFixture("key-only", "orders", null),
          requestHash: "f".repeat(64),
          idempotencyKey: "ignored-without-client",
        });
        assert.equal(keyOnly.status, "inserted");

        const highWaterMark = await getTenantHighWaterMark(tenantId, orm);
        assert.equal(highWaterMark, "4");
        const first = await getEventByOffset(tenantId, 1, orm);
        assert.equal(first?.id, "rich-event");
        assert.equal(await getEventByOffset(tenantId, 999, orm), null);

        const filtered = await listEvents(
          {
            tenantId,
            after: 0n,
            highWaterMark,
            stream: ["orders", "payments"],
            type: ["com.example.coverage.v1", "com.example.rich.v1"],
            source: ["urn:test:storage-coverage"],
            limit: 10,
          },
          orm,
        );
        assert.equal(filtered.events.length, 4);
        assert.equal(filtered.nextAfter, highWaterMark);

        const query = {
          tenantId,
          after: 0n,
          through: BigInt(highWaterMark),
          limit: 10,
          filters: { stream: ["orders"] },
        } as const;
        assert.equal((await store.list(query)).length, 3);
        assert.equal(await store.hasMatchingEvent(query), true);
        assert.equal(
          await store.hasMatchingEvent({ ...query, filters: { stream: ["missing"] } }),
          false,
        );
        assert.equal((await store.getByOffset(tenantId, 1n))?.event.id, "rich-event");
        assert.equal(await store.getByOffset(tenantId, 99n), undefined);

        assert.deepEqual(await getTenantEventBounds(tenantId, orm), {
          headOffset: "4",
          minimumAvailableOffset: "1",
        });
        assert.deepEqual(await store.getCursorBounds(tenantId), {
          headOffset: 4n,
          minimumAvailableOffset: 1n,
        });

        await pg.query('DELETE FROM events WHERE tenant_id = $1 AND "offset" = 3', [tenantId]);
        assert.equal(await store.getByOffset(tenantId, 3n), undefined);

        const direct = await appendEvent(
          {
            tenantId,
            stream: "direct",
            id: "direct-event",
            source: "urn:test:direct",
            type: "com.example.direct.v1",
            subject: "direct-subject",
            occurredAt: "2026-08-01T12:30:00.000Z",
            datacontenttype: "application/json",
            dataschema: "https://example.test/schemas/direct",
            attributes: { traceid: "direct-trace" },
            data: [1, 2, 3],
          },
          orm,
        );
        assert.equal(direct.event.offset, "5");
        assert.ok(direct.event.occurredAt instanceof Date);
      } finally {
        await pg.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
      }
    });
  },
);

function eventFixture(id: string, stream: string, data: JsonValue): CloudEvent {
  return {
    specversion: "1.0",
    id,
    source: "urn:test:storage-coverage",
    type: "com.example.coverage.v1",
    datacontenttype: "application/json",
    eventhubstream: stream,
    data,
  };
}

function requirePool(pool: Pool | undefined): Pool {
  assert.ok(pool, "PostgreSQL pool must be initialized by the suite hook");
  return pool;
}

function requireDatabase(database: Database | undefined): Database {
  assert.ok(database, "Drizzle database must be initialized by the suite hook");
  return database;
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Pool } from "pg";

import {
  ApiClientNameConflictError,
  provisionApiClient,
} from "../../src/db/api-clients.js";
import { authenticateApiKeyValue } from "../../src/db/auth.js";
import { createDatabase, type Database } from "../../src/db/database.js";
import { TenantNotFoundError } from "../../src/db/events.js";
import { requireScope } from "../../src/http/auth.js";
import { hashApiKey } from "../../src/security/api-key.js";
import { runMigrations } from "../../src/storage/migrations.js";

const testDatabaseUrl = process.env.EVENTHUB_TEST_DATABASE_URL?.trim() || undefined;

describe(
  "PostgreSQL API-client provisioning",
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
      pool = new Pool({ connectionString: testDatabaseUrl, max: 4 });
      database = createDatabase(pool);
      await runMigrations(pool);
    });

    after(async () => {
      await pool?.end();
    });

    it("stores only an API-key SHA-256 digest and prefix, then authenticates its scopes", async () => {
      const pgPool = requirePool(pool);
      const orm = requireDatabase(database);
      await withTestTenant(pgPool, async (tenantId) => {
        const created = await provisionApiClient(
          {
            tenantId,
            name: "orders-consumer",
            scopes: ["events:read"],
          },
          orm,
        );

        assert.match(created.apiKey, /^ehk_[A-Za-z0-9_-]{43}$/);
        assert.equal(created.keyPrefix, created.apiKey.slice(0, 12));
        assert.deepEqual(created.scopes, ["events:read"]);

        const stored = await pgPool.query<{
          key_hash: string;
          key_prefix: string;
          scopes: string[];
        }>(
          "SELECT key_hash, key_prefix, scopes FROM api_clients WHERE id = $1",
          [created.id],
        );
        assert.deepEqual(stored.rows[0], {
          key_hash: hashApiKey(created.apiKey),
          key_prefix: created.keyPrefix,
          scopes: ["events:read"],
        });
        assert.equal(JSON.stringify(stored.rows[0]).includes(created.apiKey), false);

        const principal = await authenticateApiKeyValue(created.apiKey, orm);
        assert.equal(principal?.id, created.id);
        assert.equal(principal?.tenantId, tenantId);
        assert.deepEqual(principal?.scopes, ["events:read"]);
        assert.ok(principal);
        const authenticatedClient = {
          clientId: principal.id,
          tenantId: principal.tenantId,
          name: principal.name,
          scopes: principal.scopes,
        };
        assert.doesNotThrow(() => requireScope(authenticatedClient, "events:read"));
        assert.throws(() => requireScope(authenticatedClient, "events:write"));
      });
    });

    it("maps duplicate names and unknown tenants to typed errors", async () => {
      const pgPool = requirePool(pool);
      const orm = requireDatabase(database);
      await withTestTenant(pgPool, async (tenantId) => {
        await provisionApiClient(
          {
            tenantId,
            name: "orders-publisher",
            scopes: ["events:write"],
          },
          orm,
        );
        await assert.rejects(
          () =>
            provisionApiClient(
              {
                tenantId,
                name: "orders-publisher",
                scopes: ["events:write"],
              },
              orm,
            ),
          (error: unknown) => {
            assert.ok(error instanceof ApiClientNameConflictError);
            assert.equal(error.tenantId, tenantId);
            assert.equal(error.clientName, "orders-publisher");
            return true;
          },
        );
      });

      const missingTenantId = randomUUID();
      await assert.rejects(
        () =>
          provisionApiClient(
            {
              tenantId: missingTenantId,
              name: "missing-tenant-client",
              scopes: ["events:read"],
            },
            orm,
          ),
        (error: unknown) => {
          assert.ok(error instanceof TenantNotFoundError);
          assert.equal(error.tenantId, missingTenantId);
          return true;
        },
      );
    });

    it("enforces the supported scope set in PostgreSQL as a defense in depth", async () => {
      const pgPool = requirePool(pool);
      await withTestTenant(pgPool, async (tenantId) => {
        await assert.rejects(
          () =>
            pgPool.query(
              `INSERT INTO api_clients (tenant_id, name, key_prefix, key_hash, scopes)
               VALUES ($1, 'invalid-scope-client', 'ehk_invalid', $2, $3::text[])`,
              [tenantId, hashApiKey(`invalid-scope-${randomUUID()}`), ["tenant:admin"]],
            ),
          (error: unknown) => {
            assert.equal((error as { code?: unknown }).code, "23514");
            assert.equal(
              (error as { constraint?: unknown }).constraint,
              "api_clients_scopes_supported",
            );
            return true;
          },
        );
      });
    });
  },
);

async function withTestTenant(pool: Pool, run: (tenantId: string) => Promise<void>): Promise<void> {
  const tenantId = randomUUID();
  await pool.query(
    "INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'API-client provisioning tenant')",
    [tenantId, `provision-test-${tenantId}`],
  );
  try {
    await run(tenantId);
  } finally {
    await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  }
}

function requirePool(pool: Pool | undefined): Pool {
  assert.ok(pool, "PostgreSQL pool must be initialized by the suite hook");
  return pool;
}

function requireDatabase(database: Database | undefined): Database {
  assert.ok(database, "Database must be initialized by the suite hook");
  return database;
}

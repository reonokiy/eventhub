import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Pool } from "pg";

import {
  ApiClientNotFoundError,
  ApiClientProvisioningValidationError,
  listApiClients,
  provisionApiClient,
  revokeApiClient,
  rotateApiClient,
} from "../../src/db/api-clients.js";
import { authenticateApiKeyValue } from "../../src/db/auth.js";
import { createDatabase, type Database } from "../../src/db/database.js";
import { TenantNotFoundError } from "../../src/db/events.js";
import {
  createTenant,
  listTenants,
  TenantManagementValidationError,
  TenantSlugConflictError,
} from "../../src/db/tenants.js";
import { runMigrations } from "../../src/storage/migrations.js";

const testDatabaseUrl = process.env.EVENTHUB_TEST_DATABASE_URL?.trim() || undefined;

describe(
  "PostgreSQL admin repository",
  {
    skip:
      testDatabaseUrl === undefined
        ? "set EVENTHUB_TEST_DATABASE_URL to run PostgreSQL integration tests"
        : false,
  },
  () => {
    let pool: Pool | undefined;
    let database: Database | undefined;
    const tenantIds: string[] = [];

    before(async () => {
      assert.ok(testDatabaseUrl, "EVENTHUB_TEST_DATABASE_URL must be set for this suite");
      pool = new Pool({ connectionString: testDatabaseUrl, max: 4 });
      database = createDatabase(pool);
      await runMigrations(pool);
    });

    after(async () => {
      const pgPool = requirePool(pool);
      await Promise.all(tenantIds.map(async (tenantId) => pgPool.query("DELETE FROM tenants WHERE id = $1", [tenantId])));
      await pgPool.end();
    });

    it("creates a tenant with a head, lists tenant metadata, and maps duplicate slugs", async () => {
      const orm = requireDatabase(database);
      const pgPool = requirePool(pool);
      const slug = `admin-${randomUUID()}`;
      const created = await createTenant(
        { slug, name: "Admin integration tenant", retentionDays: 90 },
        orm,
      );
      tenantIds.push(created.id);

      assert.equal(created.slug, slug);
      assert.equal(created.name, "Admin integration tenant");
      assert.equal(created.retentionDays, 90);
      assert.ok(created.createdAt instanceof Date);
      assert.ok(created.updatedAt instanceof Date);
      assert.deepEqual(
        (
          await pgPool.query<{ tenant_id: string; last_offset: string }>(
            "SELECT tenant_id, last_offset::text FROM tenant_heads WHERE tenant_id = $1",
            [created.id],
          )
        ).rows,
        [{ tenant_id: created.id, last_offset: "0" }],
      );

      const listed = await listTenants(orm);
      assert.deepEqual(
        listed.find((tenant) => tenant.id === created.id),
        created,
      );
      assert.ok(
        listed.every(
          (tenant, index) => index === 0 || listed[index - 1]!.slug.localeCompare(tenant.slug) <= 0,
        ),
      );

      await assert.rejects(
        () => createTenant({ slug, name: "Duplicate tenant" }, orm),
        (error: unknown) => {
          assert.ok(error instanceof TenantSlugConflictError);
          assert.equal(error.slug, slug);
          return true;
        },
      );
      await assert.rejects(
        () => createTenant({ slug: "a".repeat(64), name: "Too long slug" }, orm),
        TenantManagementValidationError,
      );
      await assert.rejects(
        () => createTenant({ slug: `long-name-${randomUUID()}`, name: "n".repeat(256) }, orm),
        TenantManagementValidationError,
      );
    });

    it("lists, rotates, and idempotently revokes tenant-scoped API clients", async () => {
      const orm = requireDatabase(database);
      const pgPool = requirePool(pool);
      const tenant = await createTenant(
        { slug: `admin-client-${randomUUID()}`, name: "Client lifecycle tenant" },
        orm,
      );
      tenantIds.push(tenant.id);
      const otherTenant = await createTenant(
        { slug: `admin-other-${randomUUID()}`, name: "Other tenant" },
        orm,
      );
      tenantIds.push(otherTenant.id);

      await assert.rejects(
        () =>
          provisionApiClient(
            { tenantId: tenant.id, name: "n".repeat(256), scopes: ["events:read"] },
            orm,
          ),
        ApiClientProvisioningValidationError,
      );
      assert.deepEqual(await listApiClients(tenant.id, orm), []);

      const created = await provisionApiClient(
        { tenantId: tenant.id, name: "orders", scopes: ["events:read", "events:write"] },
        orm,
      );
      assert.ok(created.createdAt instanceof Date);
      assert.equal(created.lastUsedAt, null);
      assert.equal(created.expiresAt, null);
      assert.equal(created.revokedAt, null);
      assert.equal(Object.hasOwn(created, "keyHash"), false);

      const listed = await listApiClients(tenant.id, orm);
      assert.deepEqual(listed, [withoutKey(created)]);
      assert.equal(JSON.stringify(listed).includes(created.apiKey), false);
      assert.equal(Object.hasOwn(listed[0]!, "keyHash"), false);

      await pgPool.query(
        `UPDATE api_clients
         SET expires_at = clock_timestamp() - interval '1 day',
             revoked_at = clock_timestamp() - interval '1 hour',
             last_used_at = clock_timestamp() - interval '2 hours'
         WHERE id = $1`,
        [created.id],
      );
      const rotated = await rotateApiClient({ tenantId: tenant.id, clientId: created.id }, orm);
      assert.equal(rotated.id, created.id);
      assert.equal(rotated.name, created.name);
      assert.deepEqual(rotated.scopes, created.scopes);
      assert.notEqual(rotated.apiKey, created.apiKey);
      assert.equal(rotated.keyPrefix, rotated.apiKey.slice(0, 12));
      assert.equal(rotated.lastUsedAt, null);
      assert.equal(rotated.expiresAt, null);
      assert.equal(rotated.revokedAt, null);
      assert.equal(await authenticateApiKeyValue(created.apiKey, orm), null);
      assert.equal((await authenticateApiKeyValue(rotated.apiKey, orm))?.id, created.id);

      const firstRevocation = await revokeApiClient(
        { tenantId: tenant.id, clientId: created.id },
        orm,
      );
      const secondRevocation = await revokeApiClient(
        { tenantId: tenant.id, clientId: created.id },
        orm,
      );
      assert.ok(firstRevocation.revokedAt instanceof Date);
      assert.equal(secondRevocation.revokedAt?.getTime(), firstRevocation.revokedAt?.getTime());
      assert.equal(secondRevocation.updatedAt.getTime(), firstRevocation.updatedAt.getTime());
      assert.equal(await authenticateApiKeyValue(rotated.apiKey, orm), null);

      const missingClientId = randomUUID();
      for (const action of [
        () => rotateApiClient({ tenantId: tenant.id, clientId: missingClientId }, orm),
        () => revokeApiClient({ tenantId: tenant.id, clientId: missingClientId }, orm),
        () => rotateApiClient({ tenantId: otherTenant.id, clientId: created.id }, orm),
      ]) {
        await assert.rejects(action, (error: unknown) => {
          assert.ok(error instanceof ApiClientNotFoundError);
          return true;
        });
      }

      await assert.rejects(() => listApiClients(randomUUID(), orm), TenantNotFoundError);
    });
  },
);

function withoutKey<Client extends { readonly apiKey: string }>(client: Client): Omit<Client, "apiKey"> {
  const { apiKey: _apiKey, ...safeClient } = client;
  return safeClient;
}

function requirePool(pool: Pool | undefined): Pool {
  assert.ok(pool, "PostgreSQL pool must be initialized by the suite hook");
  return pool;
}

function requireDatabase(database: Database | undefined): Database {
  assert.ok(database, "PostgreSQL database must be initialized by the suite hook");
  return database;
}

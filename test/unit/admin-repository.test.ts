import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ApiClientProvisioningValidationError,
  validateApiClientManagementInput,
} from "../../src/db/api-clients.js";
import type { Database } from "../../src/db/database.js";
import {
  createTenant,
  TenantManagementValidationError,
  TenantSlugConflictError,
  validateCreateTenantInput,
} from "../../src/db/tenants.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = new Date("2026-08-01T00:00:00.000Z");

describe("admin repository validation", () => {
  it("normalizes valid tenant input and applies the minimum retention default", () => {
    assert.deepEqual(
      validateCreateTenantInput({
        slug: "  acme-events  ",
        name: "  Acme Events  ",
      }),
      { slug: "acme-events", name: "Acme Events", retentionDays: 30 },
    );
    assert.deepEqual(
      validateCreateTenantInput({ slug: "acme-2", name: "Acme 2", retentionDays: 3650 }),
      { slug: "acme-2", name: "Acme 2", retentionDays: 3650 },
    );
    const maximumLength = validateCreateTenantInput({
      slug: "a".repeat(63),
      name: "n".repeat(255),
    });
    assert.equal(maximumLength.slug.length, 63);
    assert.equal(maximumLength.name.length, 255);
  });

  it("rejects malformed tenant input", () => {
    for (const input of [
      { slug: "Acme", name: "Acme" },
      { slug: "acme_events", name: "Acme" },
      { slug: "   ", name: "Acme" },
      { slug: "a".repeat(64), name: "Acme" },
      { slug: "acme", name: "   " },
      { slug: "acme", name: "n".repeat(256) },
      { slug: "acme", name: "Acme", retentionDays: 29 },
      { slug: "acme", name: "Acme", retentionDays: 3651 },
      { slug: "acme", name: "Acme", retentionDays: 30.5 },
    ]) {
      assert.throws(
        () => validateCreateTenantInput(input),
        TenantManagementValidationError,
      );
    }
  });

  it("creates the tenant and its head atomically and maps creation failures", async () => {
    const headValues: unknown[] = [];
    const created = await createTenant(
      { slug: "acme", name: "Acme", retentionDays: 90 },
      tenantDatabase({ headValues }),
    );
    assert.deepEqual(created, {
      id: TENANT_ID,
      slug: "acme",
      name: "Acme",
      retentionDays: 90,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    assert.deepEqual(headValues, [{ tenantId: TENANT_ID, lastOffset: 0n }]);

    await assert.rejects(
      () =>
        createTenant(
          { slug: "acme", name: "Acme" },
          tenantDatabase({ insertError: Object.assign(new Error("duplicate"), { code: "23505" }) }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof TenantSlugConflictError);
        assert.equal(error.slug, "acme");
        return true;
      },
    );

    const databaseError = new Error("database unavailable");
    await assert.rejects(
      () =>
        createTenant(
          { slug: "acme", name: "Acme" },
          tenantDatabase({ insertError: databaseError }),
        ),
      (error: unknown) => error === databaseError,
    );

    await assert.rejects(
      () => createTenant({ slug: "acme", name: "Acme" }, tenantDatabase({ rows: [] })),
      /Failed to create tenant/,
    );
  });

  it("validates tenant-scoped API-client management identifiers", () => {
    const valid = { tenantId: TENANT_ID, clientId: CLIENT_ID };
    assert.equal(validateApiClientManagementInput(valid), valid);
    assert.throws(
      () => validateApiClientManagementInput({ ...valid, tenantId: "not-a-uuid" }),
      ApiClientProvisioningValidationError,
    );
    assert.throws(
      () => validateApiClientManagementInput({ ...valid, clientId: "not-a-uuid" }),
      ApiClientProvisioningValidationError,
    );
  });
});

interface TenantDatabaseOptions {
  readonly headValues?: unknown[];
  readonly insertError?: unknown;
  readonly rows?: readonly unknown[];
}

function tenantDatabase(options: TenantDatabaseOptions): Database {
  let insertCount = 0;
  return {
    async transaction(callback: (transaction: never) => Promise<unknown>) {
      return callback({
        insert() {
          insertCount += 1;
          if (insertCount === 1) {
            return {
              values() {
                return {
                  async returning() {
                    if ("insertError" in options) {
                      throw options.insertError;
                    }
                    return options.rows ?? [
                      {
                        id: TENANT_ID,
                        slug: "acme",
                        name: "Acme",
                        retentionDays: 90,
                        createdAt: CREATED_AT,
                        updatedAt: CREATED_AT,
                      },
                    ];
                  },
                };
              },
            };
          }
          return {
            values(values: unknown) {
              options.headValues?.push(values);
            },
          };
        },
      } as never);
    },
  } as unknown as Database;
}

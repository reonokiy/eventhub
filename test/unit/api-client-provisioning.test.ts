import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  ApiClientNameConflictError,
  ApiClientProvisioningValidationError,
  generateApiKey,
  provisionApiClient,
  validateProvisionApiClientInput,
  type ProvisionApiClientInput,
} from "../../src/db/api-clients.js";
import type { Database } from "../../src/db/database.js";
import { TenantNotFoundError } from "../../src/db/events.js";
import {
  formatProvisionedApiClient,
  parseProvisionClientArgs,
} from "../../src/cli/provision-client.js";
import { requireScope, type AuthenticatedClient } from "../../src/http/auth.js";
import { HttpError } from "../../src/http/errors.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

describe("API client provisioning", () => {
  it("generates unique, 256-bit printable URL-safe API keys", () => {
    const first = generateApiKey();
    const second = generateApiKey();

    assert.match(first, /^ehk_[A-Za-z0-9_-]{43}$/);
    assert.match(second, /^ehk_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first, second);
  });

  it("accepts a trimmed app name and only unique event scopes", () => {
    assert.deepEqual(
      validateProvisionApiClientInput({
        tenantId: TENANT_ID,
        name: "  order-service  ",
        scopes: ["events:read", "events:write"],
      }),
      {
        tenantId: TENANT_ID,
        name: "order-service",
        scopes: ["events:read", "events:write"],
      },
    );
    assert.equal(
      validateProvisionApiClientInput({
        tenantId: TENANT_ID,
        name: "n".repeat(255),
        scopes: ["events:read"],
      }).name.length,
      255,
    );

    const invalidInputs: readonly ProvisionApiClientInput[] = [
      { tenantId: "not-a-uuid", name: "order-service", scopes: ["events:read"] },
      { tenantId: TENANT_ID, name: "   ", scopes: ["events:read"] },
      { tenantId: TENANT_ID, name: "n".repeat(256), scopes: ["events:read"] },
      { tenantId: TENANT_ID, name: "order-service", scopes: [] },
      {
        tenantId: TENANT_ID,
        name: "order-service",
        scopes: ["events:read", "events:read"],
      },
      {
        tenantId: TENANT_ID,
        name: "order-service",
        scopes: ["tenant:admin"] as unknown as readonly ("events:read" | "events:write")[],
      },
    ];

    for (const input of invalidInputs) {
      assert.throws(
        () => validateProvisionApiClientInput(input),
        ApiClientProvisioningValidationError,
      );
    }
  });

  it("parses the operator CLI arguments and emits the raw key exactly once", () => {
    assert.deepEqual(
      parseProvisionClientArgs([
        "--tenant-id",
        TENANT_ID,
        "--name",
        "orders-consumer",
        "--scope",
        "events:read",
        "--scope",
        "events:write",
      ]),
      {
        tenantId: TENANT_ID,
        name: "orders-consumer",
        scopes: ["events:read", "events:write"],
      },
    );
    assert.throws(() => parseProvisionClientArgs(["--tenant-id", TENANT_ID]));
    assert.throws(() => parseProvisionClientArgs(["--tenant-id", TENANT_ID, "--wat", "x"]));

    const apiKey = `ehk_${randomUUID().replaceAll("-", "")}`;
    const clientId = randomUUID();
    const createdAt = new Date("2026-08-01T00:00:00.000Z");
    const output = formatProvisionedApiClient({
      id: clientId,
      tenantId: TENANT_ID,
      name: "orders-consumer",
      keyPrefix: apiKey.slice(0, 12),
      scopes: ["events:read"],
      createdAt,
      updatedAt: createdAt,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      apiKey,
    });
    assert.equal(output.split(apiKey).length - 1, 1);
    assert.deepEqual(JSON.parse(output), {
      tenant_id: TENANT_ID,
      client_id: clientId,
      name: "orders-consumer",
      key_prefix: apiKey.slice(0, 12),
      scopes: ["events:read"],
      api_key: apiKey,
    });
  });

  it("produced scope sets work with exact API authorization checks", () => {
    const reader: AuthenticatedClient = {
      clientId: "client-1",
      tenantId: TENANT_ID,
      name: "orders-consumer",
      scopes: ["events:read"],
    };

    assert.doesNotThrow(() => requireScope(reader, "events:read"));
    assert.throws(
      () => requireScope(reader, "events:write"),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.statusCode, 403);
        return true;
      },
    );
  });

  it("maps insertion races to typed errors without leaking a generated key", async () => {
    const input = {
      tenantId: TENANT_ID,
      name: "orders-consumer",
      scopes: ["events:read"],
    } as const;
    const foreignKeyError = Object.assign(new Error("tenant was deleted"), {
      code: "23503",
    });
    await assert.rejects(
      () => provisionApiClient(input, provisioningDatabase({ insertError: foreignKeyError })),
      TenantNotFoundError,
    );

    const duplicateNameError = {
      cause: Object.assign(new Error("duplicate client name"), {
        code: "23505",
        constraint: "api_clients_tenant_name_unique",
      }),
    };
    await assert.rejects(
      () => provisionApiClient(input, provisioningDatabase({ insertError: duplicateNameError })),
      ApiClientNameConflictError,
    );

    await assert.rejects(
      () => provisionApiClient(input, provisioningDatabase({ returningRows: [] })),
      /Failed to create API client/,
    );

    const cyclicError = Object.assign(new Error("database failure"), { code: "23505" }) as Error & {
      cause?: unknown;
    };
    cyclicError.cause = cyclicError;
    await assert.rejects(
      () => provisionApiClient(input, provisioningDatabase({ insertError: cyclicError })),
      (error: unknown) => error === cyclicError,
    );
  });
});

interface ProvisioningDatabaseOptions {
  readonly tenantRows?: readonly unknown[];
  readonly existingRows?: readonly unknown[];
  readonly returningRows?: readonly unknown[];
  readonly insertError?: unknown;
}

function provisioningDatabase(options: ProvisioningDatabaseOptions): Database {
  const selectResults = [
    options.tenantRows ?? [{ id: TENANT_ID }],
    options.existingRows ?? [],
  ];
  return {
    select() {
      const rows = selectResults.shift() ?? [];
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  return rows;
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values() {
          return {
            async returning() {
              if ("insertError" in options) {
                throw options.insertError;
              }
              return options.returningRows ?? [
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  tenantId: TENANT_ID,
                  name: "orders-consumer",
                  keyPrefix: "ehk_example",
                  scopes: ["events:read"],
                  createdAt: new Date("2026-08-01T00:00:00.000Z"),
                  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
                  lastUsedAt: null,
                  expiresAt: null,
                  revokedAt: null,
                },
              ];
            },
          };
        },
      };
    },
  } as unknown as Database;
}

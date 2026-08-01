import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";

import {
  ApiClientNameConflictError,
  ApiClientNotFoundError,
  ApiClientProvisioningValidationError,
  TenantManagementValidationError,
  TenantNotFoundError,
  TenantSlugConflictError,
} from "../../src/db/index.js";
import {
  mapAdminRepositoryError,
  type AdminApiClient,
  type AdminProvisionedApiClient,
  type AdminRepository,
  type AdminTenant,
} from "../../src/http/routes/admin.js";
import { HttpError } from "../../src/http/errors.js";
import type { EventStore } from "../../src/service/event-store.js";
import { createTestApp } from "../support/test-app.js";

const ADMIN_HEADERS = { authorization: "Bearer dev-admin-api-key-change-me" };
const TENANT: AdminTenant = {
  id: "10000000-0000-4000-8000-000000000001",
  slug: "acme",
  name: "Acme, Inc.",
  retentionDays: 60,
  createdAt: new Date("2026-08-01T12:00:00.000Z"),
  updatedAt: new Date("2026-08-01T12:01:00.000Z"),
};
const CLIENT: AdminApiClient = {
  id: "10000000-0000-4000-8000-000000000002",
  tenantId: TENANT.id,
  name: "orders-consumer",
  keyPrefix: "ehk_abcd1234",
  scopes: ["events:read"],
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date("2026-08-01T12:00:00.000Z"),
  updatedAt: new Date("2026-08-01T12:01:00.000Z"),
  lastUsedAt: null,
};
const PROVISIONED: AdminProvisionedApiClient = {
  ...CLIENT,
  apiKey: "ehk_create_secret_that_is_only_returned_once",
};

describe("admin HTTP API", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("creates tenants and lists safe tenant metadata", async () => {
    let createInput: Parameters<AdminRepository["createTenant"]>[0] | undefined;
    app = await adminApp({
      async createTenant(input) {
        createInput = input;
        return TENANT;
      },
      async listTenants() {
        return [TENANT];
      },
    });

    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/tenants",
      headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
      payload: JSON.stringify({ slug: "acme", name: "Acme, Inc.", retention_days: 60 }),
    });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(createInput, { slug: "acme", name: "Acme, Inc.", retentionDays: 60 });
    assert.deepEqual(created.json(), publicTenant(TENANT));

    const listed = await app.inject({
      method: "GET",
      url: "/v1/admin/tenants",
      headers: ADMIN_HEADERS,
    });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json(), { tenants: [publicTenant(TENANT)] });
  });

  it("permits the optional tenant retention field to be omitted", async () => {
    let createInput: Parameters<AdminRepository["createTenant"]>[0] | undefined;
    app = await adminApp({
      async createTenant(input) {
        createInput = input;
        return TENANT;
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/tenants",
      headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
      payload: JSON.stringify({ slug: "acme", name: "Acme, Inc." }),
    });

    assert.equal(response.statusCode, 201);
    assert.deepEqual(createInput, { slug: "acme", name: "Acme, Inc." });
  });

  it("creates an independently scoped API client and never exposes its hash", async () => {
    let provisionInput: Parameters<AdminRepository["provisionApiClient"]>[0] | undefined;
    app = await adminApp({
      async provisionApiClient(input) {
        provisionInput = input;
        return PROVISIONED;
      },
      async listApiClients() {
        return [CLIENT];
      },
    });

    const created = await app.inject({
      method: "POST",
      url: `/v1/admin/tenants/${TENANT.id}/api-clients`,
      headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
      payload: JSON.stringify({ name: "orders-consumer", scopes: ["events:read"] }),
    });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(provisionInput, {
      tenantId: TENANT.id,
      name: "orders-consumer",
      scopes: ["events:read"],
    });
    assert.deepEqual(created.json(), {
      api_key: PROVISIONED.apiKey,
      client: publicClient(PROVISIONED),
    });
    assert.doesNotMatch(created.body, /key_hash/i);

    const listed = await app.inject({
      method: "GET",
      url: `/v1/admin/tenants/${TENANT.id}/api-clients`,
      headers: ADMIN_HEADERS,
    });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json(), { api_clients: [publicClient(CLIENT)] });
    assert.doesNotMatch(listed.body, /api_key|secret_that_is_only/i);
  });

  it("rotates and revokes clients while returning raw key material only for rotation", async () => {
    let rotateInput: Parameters<AdminRepository["rotateApiClient"]>[0] | undefined;
    let revokeInput: Parameters<AdminRepository["revokeApiClient"]>[0] | undefined;
    const rotated: AdminProvisionedApiClient = {
      ...CLIENT,
      keyPrefix: "ehk_rotated1",
      updatedAt: new Date("2026-08-02T12:01:00.000Z"),
      lastUsedAt: new Date("2026-08-02T12:00:00.000Z"),
      apiKey: "ehk_rotation_secret_that_is_only_returned_once",
    };
    const revoked: AdminApiClient = {
      ...rotated,
      revokedAt: new Date("2026-08-03T12:00:00.000Z"),
    };
    app = await adminApp({
      async rotateApiClient(input) {
        rotateInput = input;
        return rotated;
      },
      async revokeApiClient(input) {
        revokeInput = input;
        return revoked;
      },
    });

    const rotatedResponse = await app.inject({
      method: "POST",
      url: `/v1/admin/tenants/${TENANT.id}/api-clients/${CLIENT.id}/rotate`,
      headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
      payload: "{}",
    });
    assert.equal(rotatedResponse.statusCode, 200);
    assert.deepEqual(rotateInput, { tenantId: TENANT.id, clientId: CLIENT.id });
    assert.deepEqual(rotatedResponse.json(), {
      api_key: rotated.apiKey,
      client: publicClient(rotated),
    });

    const revokedResponse = await app.inject({
      method: "POST",
      url: `/v1/admin/tenants/${TENANT.id}/api-clients/${CLIENT.id}/revoke`,
      headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
      payload: "{}",
    });
    assert.equal(revokedResponse.statusCode, 200);
    assert.deepEqual(revokeInput, { tenantId: TENANT.id, clientId: CLIENT.id });
    assert.deepEqual(revokedResponse.json(), { client: publicClient(revoked) });
    assert.doesNotMatch(revokedResponse.body, /api_key|rotation_secret/i);
  });

  it("rejects absent, application, and malformed admin credentials before parsing the body", async () => {
    app = await adminApp({});
    for (const headers of [
      {},
      { authorization: "Bearer dev-api-key-change-me" },
      { authorization: "Basic dev-admin-api-key-change-me" },
    ]) {
      const response: Awaited<ReturnType<FastifyInstance["inject"]>> = await app.inject({
        method: "POST",
        url: "/v1/admin/tenants",
        headers,
        payload: "not-json",
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, "admin_unauthorized");
    }
  });

  it("requires JSON content types for every administrative mutation", async () => {
    app = await adminApp({});
    for (const request of [
      { url: "/v1/admin/tenants", payload: "{}" },
      { url: `/v1/admin/tenants/${TENANT.id}/api-clients`, payload: "{}" },
      { url: `/v1/admin/tenants/${TENANT.id}/api-clients/${CLIENT.id}/rotate`, payload: "{}" },
      { url: `/v1/admin/tenants/${TENANT.id}/api-clients/${CLIENT.id}/revoke`, payload: "{}" },
    ]) {
      const response: Awaited<ReturnType<FastifyInstance["inject"]>> = await app.inject({
        method: "POST",
        url: request.url,
        headers: ADMIN_HEADERS,
        payload: request.payload,
      });
      assert.equal(response.statusCode, 415);
      assert.equal(response.json().code, "unsupported_media_type");
    }
  });

  it("returns stable 400 problems for malformed admin JSON and request shapes", async () => {
    app = await adminApp({});
    const cases: readonly { readonly url: string; readonly payload: string }[] = [
      { url: "/v1/admin/tenants", payload: "not-json" },
      { url: "/v1/admin/tenants", payload: "[]" },
      { url: "/v1/admin/tenants", payload: '{"slug":"acme","name":"Acme","extra":true}' },
      { url: "/v1/admin/tenants", payload: '{"slug":1,"name":"Acme"}' },
      { url: "/v1/admin/tenants", payload: '{"slug":"acme","name":"Acme","retention_days":1.5}' },
      {
        url: `/v1/admin/tenants/${TENANT.id}/api-clients`,
        payload: '{"name":"client","scopes":"events:read"}',
      },
      {
        url: `/v1/admin/tenants/${TENANT.id}/api-clients`,
        payload: '{"name":"client","scopes":[]}',
      },
      {
        url: `/v1/admin/tenants/${TENANT.id}/api-clients`,
        payload: '{"name":"client","scopes":["wrong"]}',
      },
      {
        url: `/v1/admin/tenants/${TENANT.id}/api-clients/${CLIENT.id}/rotate`,
        payload: '{"unexpected":true}',
      },
    ];
    for (const testCase of cases) {
      const response: Awaited<ReturnType<FastifyInstance["inject"]>> = await app.inject({
        method: "POST",
        url: testCase.url,
        headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
        payload: testCase.payload,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "invalid_admin_request");
    }
  });

  it("validates tenant and client IDs before passing them to the repository", async () => {
    app = await adminApp({});
    const requests = [
      { method: "GET", url: "/v1/admin/tenants/not-a-uuid/api-clients" },
      {
        method: "POST",
        url: `/v1/admin/tenants/${TENANT.id}/api-clients/not-a-uuid/rotate`,
      },
      {
        method: "POST",
        url: `/v1/admin/tenants/not-a-uuid/api-clients/${CLIENT.id}/revoke`,
      },
    ] as const;
    for (const request of requests) {
      const response: Awaited<ReturnType<FastifyInstance["inject"]>> = await app.inject({
        method: request.method,
        url: request.url,
        headers:
          request.method === "POST"
            ? { ...ADMIN_HEADERS, "content-type": "application/json" }
            : ADMIN_HEADERS,
        ...(request.method === "POST" ? { payload: "{}" } : {}),
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "invalid_admin_request");
    }
  });

  it("maps tenant/client validation, absence, and conflict errors to stable problems", async () => {
    const cases: readonly {
      readonly build: () => Partial<AdminRepository>;
      readonly request: { readonly method: "GET" | "POST"; readonly url: string; readonly payload?: string };
      readonly status: number;
      readonly code: string;
    }[] = [
      {
        build: () => ({
          async createTenant() {
            throw new TenantManagementValidationError("invalid tenant");
          },
        }),
        request: { method: "POST", url: "/v1/admin/tenants", payload: '{"slug":"a","name":"A"}' },
        status: 400,
        code: "invalid_admin_request",
      },
      {
        build: () => ({
          async createTenant() {
            throw new TenantSlugConflictError("acme");
          },
        }),
        request: { method: "POST", url: "/v1/admin/tenants", payload: '{"slug":"acme","name":"A"}' },
        status: 409,
        code: "tenant_slug_conflict",
      },
      {
        build: () => ({
          async listApiClients() {
            throw new TenantNotFoundError(TENANT.id);
          },
        }),
        request: { method: "GET", url: `/v1/admin/tenants/${TENANT.id}/api-clients` },
        status: 404,
        code: "tenant_not_found",
      },
      {
        build: () => ({
          async provisionApiClient() {
            throw new ApiClientProvisioningValidationError("invalid scopes");
          },
        }),
        request: {
          method: "POST",
          url: `/v1/admin/tenants/${TENANT.id}/api-clients`,
          payload: '{"name":"client","scopes":["events:read"]}',
        },
        status: 400,
        code: "invalid_admin_request",
      },
      {
        build: () => ({
          async provisionApiClient() {
            throw new ApiClientNameConflictError(TENANT.id, "client");
          },
        }),
        request: {
          method: "POST",
          url: `/v1/admin/tenants/${TENANT.id}/api-clients`,
          payload: '{"name":"client","scopes":["events:read"]}',
        },
        status: 409,
        code: "api_client_name_conflict",
      },
      {
        build: () => ({
          async rotateApiClient() {
            throw new ApiClientNotFoundError(TENANT.id, CLIENT.id);
          },
        }),
        request: {
          method: "POST",
          url: `/v1/admin/tenants/${TENANT.id}/api-clients/${CLIENT.id}/rotate`,
          payload: "{}",
        },
        status: 404,
        code: "api_client_not_found",
      },
    ];
    for (const testCase of cases) {
      app = await adminApp(testCase.build());
      const response = await app.inject({
        method: testCase.request.method,
        url: testCase.request.url,
        headers:
          testCase.request.method === "POST"
            ? { ...ADMIN_HEADERS, "content-type": "application/json" }
            : ADMIN_HEADERS,
        ...(testCase.request.payload === undefined ? {} : { payload: testCase.request.payload }),
      });
      assert.equal(response.statusCode, testCase.status);
      assert.equal(response.json().code, testCase.code);
      await app.close();
      app = undefined;
    }
  });

  it("preserves HTTP errors and safely wraps unknown repository failures", () => {
    const httpError = new HttpError(400, "invalid_admin_request", "bad request");
    assert.equal(mapAdminRepositoryError(httpError), httpError);

    const error = new Error("not an HTTP error");
    assert.equal(mapAdminRepositoryError(error), error);

    const mappedPrimitive = mapAdminRepositoryError("bad state");
    assert.equal(mappedPrimitive.message, "Unknown admin repository error");
    assert.equal(mappedPrimitive.cause, "bad state");
  });
});

function publicTenant(tenant: AdminTenant) {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    retention_days: tenant.retentionDays,
    created_at: tenant.createdAt.toISOString(),
    updated_at: tenant.updatedAt.toISOString(),
  };
}

function publicClient(client: AdminApiClient) {
  return {
    id: client.id,
    tenant_id: client.tenantId,
    name: client.name,
    key_prefix: client.keyPrefix,
    scopes: client.scopes,
    expires_at: client.expiresAt?.toISOString() ?? null,
    revoked_at: client.revokedAt?.toISOString() ?? null,
    created_at: client.createdAt.toISOString(),
    updated_at: client.updatedAt.toISOString(),
    last_used_at: client.lastUsedAt?.toISOString() ?? null,
  };
}

function adminRepository(overrides: Partial<AdminRepository>): AdminRepository {
  return {
    async createTenant() {
      return TENANT;
    },
    async listTenants() {
      return [];
    },
    async listApiClients() {
      return [];
    },
    async provisionApiClient() {
      return PROVISIONED;
    },
    async rotateApiClient() {
      return PROVISIONED;
    },
    async revokeApiClient() {
      return CLIENT;
    },
    ...overrides,
  };
}

async function adminApp(overrides: Partial<AdminRepository>): Promise<FastifyInstance> {
  return createTestApp({
    eventStore: eventStoreStub(),
    adminRepository: adminRepository(overrides),
  });
}

function eventStoreStub(): EventStore {
  return {
    async append() {
      throw new Error("unexpected append");
    },
    async getByOffset() {
      return undefined;
    },
    async list() {
      return [];
    },
    async hasMatchingEvent() {
      return false;
    },
    async getCursorBounds() {
      return { headOffset: 0n, minimumAvailableOffset: 1n };
    },
  };
}

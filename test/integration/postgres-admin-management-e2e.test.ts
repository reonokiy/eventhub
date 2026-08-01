import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { buildApp } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { ensureBootstrapTenantAndClient } from "../../src/db/bootstrap.js";
import { createDatabase, type Database } from "../../src/db/database.js";
import type { EventNotifier, WakeReason } from "../../src/realtime/notifier.js";
import { runMigrations } from "../../src/storage/migrations.js";

const testDatabaseUrl = process.env.EVENTHUB_TEST_DATABASE_URL?.trim() || undefined;

describe(
  "administrator tenant and API-client management over PostgreSQL and HTTP",
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

    it(
      "keeps management credentials separate while provisioning, rotating, and revoking a reader",
      { timeout: 15_000 },
      async () => {
      const pgPool = requirePool(pool);
      const orm = requireDatabase(database);
      const nonce = randomUUID();
      const bootstrapTenantId = randomUUID();
      const bootstrapApiKey = `bootstrap-admin-e2e-${randomUUID()}`;
      const adminApiKey = `administrator-e2e-${randomUUID()}`;
      const managedTenantSlug = `admin-management-e2e-${nonce}`;
      let app: FastifyInstance | undefined;
      let rotatedCredentialStream: OpenSseStream | undefined;
      let revokedCredentialStream: OpenSseStream | undefined;

      try {
        const config = e2eConfig({
          databaseUrl: requireTestDatabaseUrl(),
          bootstrapTenantId,
          bootstrapApiKey,
          adminApiKey,
        });
        await ensureBootstrapTenantAndClient(
          {
            tenantId: config.bootstrapTenantId,
            tenantSlug: `bootstrap-admin-e2e-${nonce}`,
            tenantName: "Admin-management bootstrap tenant",
            apiKey: config.bootstrapApiKey,
          },
          orm,
        );

        app = await buildApp({
          config,
          pool: pgPool,
          database: orm,
          notifier: new PollingOnlyNotifier(),
        });
        const address = await app.listen({ host: "127.0.0.1", port: 0 });

        const applicationAdminAttempt = await fetch(`${address}/v1/admin/tenants`, {
          headers: bearer(bootstrapApiKey),
        });
        const applicationAdminProblem = await expectJson<ProblemDetail>(
          applicationAdminAttempt,
          401,
        );
        assert.equal(applicationAdminProblem.code, "admin_unauthorized");

        const adminEventsAttempt = await fetch(`${address}/v1/events?after=0`, {
          headers: bearer(adminApiKey),
        });
        const adminEventsProblem = await expectJson<ProblemDetail>(adminEventsAttempt, 401);
        assert.equal(adminEventsProblem.code, "unauthorized");

        for (const body of [
          { slug: "a".repeat(64), name: "Oversized slug" },
          { slug: `oversized-name-${nonce}`, name: "n".repeat(256) },
        ]) {
          const invalidTenant = await expectJson<ProblemDetail>(
            await fetch(`${address}/v1/admin/tenants`, {
              method: "POST",
              headers: jsonBearer(adminApiKey),
              body: JSON.stringify(body),
            }),
            400,
          );
          assert.equal(invalidTenant.code, "invalid_admin_request");
        }

        const createdTenant = await expectJson<PublicTenant>(
          await fetch(`${address}/v1/admin/tenants`, {
            method: "POST",
            headers: jsonBearer(adminApiKey),
            body: JSON.stringify({
              slug: managedTenantSlug,
              name: "Managed end-to-end tenant",
              retention_days: 45,
            }),
          }),
          201,
        );
        assert.equal(createdTenant.slug, managedTenantSlug);
        assert.equal(createdTenant.name, "Managed end-to-end tenant");
        assert.equal(createdTenant.retention_days, 45);

        const invalidClient = await expectJson<ProblemDetail>(
          await fetch(`${address}/v1/admin/tenants/${createdTenant.id}/api-clients`, {
            method: "POST",
            headers: jsonBearer(adminApiKey),
            body: JSON.stringify({ name: "n".repeat(256), scopes: ["events:read"] }),
          }),
          400,
        );
        assert.equal(invalidClient.code, "invalid_admin_request");

        const tenantList = await expectJson<PublicTenantList>(
          await fetch(`${address}/v1/admin/tenants`, { headers: bearer(adminApiKey) }),
          200,
        );
        assert.ok(
          tenantList.tenants.some((tenant) => tenant.id === createdTenant.id),
          "the administrator list must include the tenant it just created",
        );

        const provisioned = await expectJson<ProvisionedApiClient>(
          await fetch(`${address}/v1/admin/tenants/${createdTenant.id}/api-clients`, {
            method: "POST",
            headers: jsonBearer(adminApiKey),
            body: JSON.stringify({ name: "reporting-reader", scopes: ["events:read"] }),
          }),
          201,
        );
        assert.match(provisioned.api_key, /^ehk_[A-Za-z0-9_-]+$/);
        assert.deepEqual(provisioned.client.scopes, ["events:read"]);
        assertNoKeyMaterial(provisioned.client);

        const writer = await expectJson<ProvisionedApiClient>(
          await fetch(`${address}/v1/admin/tenants/${createdTenant.id}/api-clients`, {
            method: "POST",
            headers: jsonBearer(adminApiKey),
            body: JSON.stringify({ name: "orders-publisher", scopes: ["events:write"] }),
          }),
          201,
        );
        assert.deepEqual(writer.client.scopes, ["events:write"]);

        const clientList = await expectJson<PublicApiClientList>(
          await fetch(`${address}/v1/admin/tenants/${createdTenant.id}/api-clients`, {
            headers: bearer(adminApiKey),
          }),
          200,
        );
        assert.equal(clientList.api_clients.length, 2);
        const listedClient = clientList.api_clients.find(
          (client) => client.id === provisioned.client.id,
        );
        assert.ok(listedClient, "the provisioned client must appear in the administrator list");
        assert.equal(listedClient.id, provisioned.client.id);
        assertNoKeyMaterial(listedClient);
        assert.equal(JSON.stringify(clientList).includes(provisioned.api_key), false);
        assert.equal(JSON.stringify(clientList).includes('"api_key"'), false);
        assert.equal(JSON.stringify(clientList).includes('"key_hash"'), false);

        rotatedCredentialStream = await openSse(address, provisioned.api_key, "0");

        const rotated = await expectJson<ProvisionedApiClient>(
          await fetch(
            `${address}/v1/admin/tenants/${createdTenant.id}/api-clients/${provisioned.client.id}/rotate`,
            {
              method: "POST",
              headers: jsonBearer(adminApiKey),
              body: "{}",
            },
          ),
          200,
        );
        assert.notEqual(rotated.api_key, provisioned.api_key);
        assert.equal(rotated.client.id, provisioned.client.id);
        assertNoKeyMaterial(rotated.client);

        const oldKeyRead = await expectJson<ProblemDetail>(
          await fetch(`${address}/v1/events?after=0`, { headers: bearer(provisioned.api_key) }),
          401,
        );
        assert.equal(oldKeyRead.code, "unauthorized");

        const postRotationOffset = await publishCloudEvent(
          address,
          writer.api_key,
          `post-rotation-${nonce}`,
        );
        assert.equal(postRotationOffset, "1");
        await assertSseClosedWithoutBusinessEvent(rotatedCredentialStream);
        rotatedCredentialStream = undefined;

        const freshKeyRead = await expectJson<EventListResponse>(
          await fetch(`${address}/v1/events?after=0`, { headers: bearer(rotated.api_key) }),
          200,
        );
        assert.equal(freshKeyRead.events.length, 1);
        assert.equal(freshKeyRead.page.head_offset, "1");

        revokedCredentialStream = await openSse(address, rotated.api_key, postRotationOffset);

        const revoked = await expectJson<RevokedApiClientResponse>(
          await fetch(
            `${address}/v1/admin/tenants/${createdTenant.id}/api-clients/${provisioned.client.id}/revoke`,
            {
              method: "POST",
              headers: jsonBearer(adminApiKey),
              body: "{}",
            },
          ),
          200,
        );
        assert.equal(revoked.client.id, provisioned.client.id);
        assert.notEqual(revoked.client.revoked_at, null);
        assert.equal(Object.hasOwn(revoked, "api_key"), false);
        assertNoKeyMaterial(revoked.client);

        const postRevocationOffset = await publishCloudEvent(
          address,
          writer.api_key,
          `post-revocation-${nonce}`,
        );
        assert.equal(postRevocationOffset, "2");
        await assertSseClosedWithoutBusinessEvent(revokedCredentialStream);
        revokedCredentialStream = undefined;

        const revokedKeyRead = await expectJson<ProblemDetail>(
          await fetch(`${address}/v1/events?after=0`, { headers: bearer(rotated.api_key) }),
          401,
        );
        assert.equal(revokedKeyRead.code, "unauthorized");

        const clientListAfterRevoke = await expectJson<PublicApiClientList>(
          await fetch(`${address}/v1/admin/tenants/${createdTenant.id}/api-clients`, {
            headers: bearer(adminApiKey),
          }),
          200,
        );
        const revokedClient = clientListAfterRevoke.api_clients.find(
          (client) => client.id === provisioned.client.id,
        );
        assert.ok(revokedClient, "the revoked client must remain visible to administrators");
        assert.notEqual(revokedClient.revoked_at, null);
        assertNoKeyMaterial(revokedClient);
      } finally {
        try {
          await closeSse(rotatedCredentialStream);
          await closeSse(revokedCredentialStream);
          await app?.close();
        } finally {
          await pgPool.query("DELETE FROM tenants WHERE slug = $1", [managedTenantSlug]);
          await pgPool.query("DELETE FROM tenants WHERE id = $1", [bootstrapTenantId]);
        }
      }
      },
    );
  },
);

class PollingOnlyNotifier implements EventNotifier {
  public async waitForTenant(
    _tenantId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WakeReason> {
    if (isAborted(signal)) {
      return "aborted";
    }
    try {
      await delay(timeoutMs, undefined, { signal, ref: false });
      return "poll";
    } catch (error) {
      if (isAborted(signal)) {
        return "aborted";
      }
      throw error;
    }
  }
}

interface PublicTenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly retention_days: number;
}

interface PublicTenantList {
  readonly tenants: readonly PublicTenant[];
}

interface PublicApiClient {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly key_prefix: string;
  readonly scopes: readonly string[];
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_used_at: string | null;
}

interface ProvisionedApiClient {
  readonly api_key: string;
  readonly client: PublicApiClient;
}

interface PublicApiClientList {
  readonly api_clients: readonly PublicApiClient[];
}

interface RevokedApiClientResponse {
  readonly client: PublicApiClient;
}

interface EventListResponse {
  readonly events: readonly unknown[];
  readonly page: {
    readonly head_offset: string;
  };
}

interface ProblemDetail {
  readonly code: string;
}

interface OpenSseStream {
  readonly controller: AbortController;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
}

async function openSse(address: string, apiKey: string, after: string): Promise<OpenSseStream> {
  const controller = new AbortController();
  const response = await fetch(`${address}/v1/events/stream?after=${after}`, {
    headers: {
      ...bearer(apiKey),
      accept: "text/event-stream",
    },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.ok(response.body, "SSE response must have a readable body");
  return { controller, reader: response.body.getReader() };
}

async function assertSseClosedWithoutBusinessEvent(stream: OpenSseStream | undefined): Promise<void> {
  assert.ok(stream, "SSE stream must have been opened before credential invalidation");
  const decoder = new TextDecoder();
  let body = "";
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Timed out waiting for invalidated SSE connection to close")),
      5000,
    );
    timer.unref();
  });

  try {
    while (true) {
      const chunk = await Promise.race([stream.reader.read(), deadline]);
      if (chunk.done) {
        body += decoder.decode();
        break;
      }
      body += decoder.decode(chunk.value, { stream: true });
      assert.doesNotMatch(body, /(?:^|\n)event: /);
    }
    assert.match(body, /retry: 3000/);
    assert.doesNotMatch(body, /(?:^|\n)event: /);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function closeSse(stream: OpenSseStream | undefined): Promise<void> {
  if (stream === undefined) {
    return;
  }
  stream.controller.abort();
  await stream.reader.cancel().catch(() => undefined);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function publishCloudEvent(address: string, apiKey: string, id: string): Promise<string> {
  const published = await expectJson<{ readonly eventhuboffset?: unknown }>(
    await fetch(`${address}/v1/events`, {
      method: "POST",
      headers: {
        ...bearer(apiKey),
        "content-type": "application/cloudevents+json",
      },
      body: JSON.stringify({
        specversion: "1.0",
        id,
        source: "urn:test:admin-management",
        type: "com.example.admin-management.v1",
        datacontenttype: "application/json",
        eventhubstream: "admin-management",
        data: { id },
      }),
    }),
    201,
  );
  if (typeof published.eventhuboffset !== "string") {
    throw new TypeError("Published event must contain a string eventhuboffset");
  }
  return published.eventhuboffset;
}

function bearer(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

function jsonBearer(apiKey: string): Record<string, string> {
  return { ...bearer(apiKey), "content-type": "application/json" };
}

function assertNoKeyMaterial(client: PublicApiClient): void {
  assert.equal(Object.hasOwn(client, "api_key"), false);
  assert.equal(Object.hasOwn(client, "key_hash"), false);
}

async function expectJson<ResponseBody>(response: Response, expectedStatus: number): Promise<ResponseBody> {
  const body = await response.text();
  assert.equal(response.status, expectedStatus, body);
  return JSON.parse(body) as ResponseBody;
}

interface E2eConfigInput {
  readonly databaseUrl: string;
  readonly bootstrapTenantId: string;
  readonly bootstrapApiKey: string;
  readonly adminApiKey: string;
}

function e2eConfig(input: E2eConfigInput): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.EVENTHUB_TEST_LOG_LEVEL ?? "silent",
    DATABASE_URL: input.databaseUrl,
    BOOTSTRAP_TENANT_ID: input.bootstrapTenantId,
    BOOTSTRAP_TENANT_NAME: "Admin-management bootstrap tenant",
    BOOTSTRAP_API_KEY: input.bootstrapApiKey,
    ADMIN_API_KEY: input.adminApiKey,
    BOOTSTRAP_WEBHOOK_CONNECTION_ID: randomUUID(),
    BOOTSTRAP_WEBHOOK_SECRET: `admin-management-webhook-${randomUUID()}`,
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

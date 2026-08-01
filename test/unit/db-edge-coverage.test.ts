import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authenticateApiKey,
  authenticateApiKeyValue,
  mapPrincipal,
  verifyActiveApiKey,
} from "../../src/db/auth.js";
import { ensureBootstrapTenantAndClient } from "../../src/db/bootstrap.js";
import { getSourceConnection } from "../../src/db/connections.js";
import type { Database } from "../../src/db/database.js";
import {
  appendEvent,
  computeEnvelopeHash,
  CursorAheadError,
  EventIdentityConflictError,
  getEventByOffset,
  getTenantEventBounds,
  getTenantHighWaterMark,
  hashIdempotencyKey,
  IdempotencyKeyConflictError,
  listEvents,
  TenantNotFoundError,
} from "../../src/db/events.js";
import type { AppendEventInput, StoredEvent as DatabaseStoredEvent } from "../../src/db/types.js";
import type { CloudEvent } from "../../src/domain/cloud-event.js";
import {
  PostgresApiClientAuthenticator,
  PostgresSourceConnectionStore,
} from "../../src/storage/postgres-auth.js";
import { PostgresEventStore } from "../../src/storage/postgres-event-store.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_ID = "00000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000003";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("database edge cases", () => {
  it("rejects malformed hashes and maps API-client query results", async () => {
    assert.equal(await authenticateApiKey("not-a-hash", unusedDatabase()), null);
    assert.equal(await verifyActiveApiKey("not-a-hash", unusedDatabase()), null);

    const absentDatabase = updateRowsDatabase([]);
    assert.equal(await authenticateApiKey(SHA_A, absentDatabase), null);
    assert.equal(await verifyActiveApiKey(SHA_A, selectRowsDatabase([[]])), null);

    const expiresAt = new Date("2030-01-02T03:04:05.000Z");
    const row = {
      id: CLIENT_ID,
      tenantId: TENANT_ID,
      name: "coverage client",
      keyPrefix: "coverage-key",
      scopes: ["events:read"],
      expiresAt,
    };
    assert.deepEqual(await authenticateApiKey(SHA_A, updateRowsDatabase([row])), row);
    assert.deepEqual(await verifyActiveApiKey(SHA_A, selectRowsDatabase([[row]])), row);
    assert.deepEqual(mapPrincipal(row), row);

    const valueDatabase = updateRowsDatabase([{ ...row, expiresAt: null }]);
    const valuePrincipal = await authenticateApiKeyValue("coverage-api-key", valueDatabase);
    assert.equal(valuePrincipal?.id, CLIENT_ID);
    assert.equal(valuePrincipal?.expiresAt, null);
  });

  it("validates every bootstrap option boundary", async () => {
    const base = {
      tenantId: TENANT_ID,
      tenantName: "Coverage tenant",
      apiKey: "coverage-key",
    } as const;

    await assert.rejects(
      () => ensureBootstrapTenantAndClient({ ...base, tenantName: "  " }, unusedDatabase()),
      { name: "TypeError", message: "tenantName must not be blank" },
    );
    await assert.rejects(
      () => ensureBootstrapTenantAndClient({ ...base, apiKey: "short" }, unusedDatabase()),
      { name: "TypeError" },
    );
    await assert.rejects(
      () => ensureBootstrapTenantAndClient({ ...base, apiKey: "has space" }, unusedDatabase()),
      { name: "TypeError" },
    );
    await assert.rejects(
      () => ensureBootstrapTenantAndClient({ ...base, retentionDays: 30.5 }, unusedDatabase()),
      { name: "RangeError" },
    );
    await assert.rejects(
      () => ensureBootstrapTenantAndClient({ ...base, retentionDays: 29 }, unusedDatabase()),
      { name: "RangeError" },
    );
    await assert.rejects(
      () => ensureBootstrapTenantAndClient({ ...base, retentionDays: 3651 }, unusedDatabase()),
      { name: "RangeError" },
    );
    await assert.rejects(
      () => ensureBootstrapTenantAndClient({ ...base, scopes: [] }, unusedDatabase()),
      { name: "TypeError" },
    );
    await assert.rejects(
      () => ensureBootstrapTenantAndClient({ ...base, scopes: ["events:read", " "] }, unusedDatabase()),
      { name: "TypeError" },
    );
    await assert.rejects(
      () =>
        ensureBootstrapTenantAndClient(
          { ...base, scopes: ["events:read", "events:read"] },
          unusedDatabase(),
        ),
      { name: "TypeError" },
    );
    await assert.rejects(
      () =>
        ensureBootstrapTenantAndClient(
          { ...base, webhook: { id: CONNECTION_ID, secret: "too-short" } },
          unusedDatabase(),
        ),
      { name: "TypeError" },
    );
    await assert.rejects(
      () =>
        ensureBootstrapTenantAndClient(
          { ...base, webhook: { id: CONNECTION_ID, secret: "                    " } },
          unusedDatabase(),
        ),
      { name: "TypeError" },
    );
  });

  it("uses bootstrap defaults and reports impossible empty insert results", async () => {
    const apiClient = {
      id: CLIENT_ID,
      tenantId: TENANT_ID,
      name: "bootstrap",
      keyPrefix: "coverage-key",
      scopes: ["events:read", "events:write"],
      expiresAt: null,
    };
    const defaults = await ensureBootstrapTenantAndClient(
      {
        tenantId: TENANT_ID,
        tenantName: "Coverage tenant",
        apiKey: "coverage-key",
      },
      bootstrapDatabase([apiClient]),
    );
    assert.deepEqual(defaults, {
      tenantId: TENANT_ID,
      apiClient,
      sourceConnectionId: null,
    });

    await assert.rejects(
      () =>
        ensureBootstrapTenantAndClient(
          {
            tenantId: TENANT_ID,
            tenantSlug: "coverage",
            tenantName: "Coverage tenant",
            retentionDays: 3650,
            apiKey: "coverage-key",
            apiClientName: "custom",
            scopes: ["events:read"],
          },
          bootstrapDatabase([]),
        ),
      /Failed to ensure the bootstrap API client/,
    );
  });

  it("uses webhook defaults and rejects a missing webhook upsert row", async () => {
    const apiClient = {
      id: CLIENT_ID,
      tenantId: TENANT_ID,
      name: "bootstrap",
      keyPrefix: "coverage-key",
      scopes: ["events:read", "events:write"],
      expiresAt: null,
    };
    const options = {
      tenantId: TENANT_ID,
      tenantName: "Coverage tenant",
      apiKey: "coverage-key",
      webhook: {
        id: CONNECTION_ID,
        secret: "coverage-webhook-secret",
      },
    } as const;
    const result = await ensureBootstrapTenantAndClient(
      options,
      bootstrapDatabase([apiClient], [{ id: CONNECTION_ID }]),
    );
    assert.equal(result.sourceConnectionId, CONNECTION_ID);

    await assert.rejects(
      () => ensureBootstrapTenantAndClient(options, bootstrapDatabase([apiClient], [])),
      /Bootstrap webhook connection ID belongs to another tenant/,
    );
  });

  it("handles invalid, absent, and present source connections", async () => {
    assert.equal(await getSourceConnection("hmac", "bad-id", unusedDatabase()), null);
    assert.equal(
      await getSourceConnection("hmac", CONNECTION_ID, selectRowsDatabase([[]])),
      null,
    );

    const connection = {
      id: CONNECTION_ID,
      tenantId: TENANT_ID,
      provider: "hmac",
      name: "coverage",
      stream: "orders",
      signingSecret: "coverage-webhook-secret",
      config: { version: 1 },
      checkpoint: null,
    } as const;
    assert.deepEqual(
      await getSourceConnection("hmac", CONNECTION_ID, selectRowsDatabase([[connection]])),
      connection,
    );
  });

  it("validates append hashes and retention settings", async () => {
    const base = appendInput();
    await assert.rejects(
      () => appendEvent({ ...base, envelopeHash: "BAD" }, unusedDatabase()),
      /envelopeHash must be a lowercase SHA-256 hex digest/,
    );
    await assert.rejects(
      () =>
        appendEvent(
          { ...base, idempotency: { apiClientId: CLIENT_ID, keyHash: "BAD" } },
          unusedDatabase(),
        ),
      /idempotency.keyHash must be a lowercase SHA-256 hex digest/,
    );
    await assert.rejects(
      () =>
        appendEvent(
          {
            ...base,
            idempotency: { apiClientId: CLIENT_ID, keyHash: SHA_A, requestHash: "BAD" },
          },
          unusedDatabase(),
        ),
      /idempotency.requestHash must be a lowercase SHA-256 hex digest/,
    );
    for (const retentionDays of [30.5, 29, 3651]) {
      await assert.rejects(
        () =>
          appendEvent(
            {
              ...base,
              idempotency: { apiClientId: CLIENT_ID, keyHash: SHA_A, retentionDays },
            },
            unusedDatabase(),
          ),
        /idempotency retentionDays must be an integer between 30 and 3650/,
      );
    }
  });

  it("maps append rows and all database conflict shapes", async () => {
    const row = eventRow({ receivedAt: "2026-08-01T12:00:00.000Z" });
    const inserted = await appendEvent(
      {
        ...appendInput(),
        subject: null,
        occurredAt: null,
        dataschema: null,
        idempotency: { apiClientId: CLIENT_ID, keyHash: SHA_A },
      },
      executeRowsDatabase([{ ...row, inserted: true, replayReason: null }]),
    );
    assert.equal(inserted.inserted, true);
    assert.ok(inserted.event.receivedAt instanceof Date);

    await assert.rejects(
      () => appendEvent(appendInput(), executeErrorDatabase(databaseError("event_identity_conflict"))),
      EventIdentityConflictError,
    );
    await assert.rejects(
      () =>
        appendEvent(
          appendInput(),
          executeErrorDatabase({ cause: { cause: databaseError("idempotency_key_conflict") } }),
        ),
      IdempotencyKeyConflictError,
    );
    await assert.rejects(
      () => appendEvent(appendInput(), executeRowsDatabase([])),
      /eventhub_append_event returned no event/,
    );

    const unknown = Object.assign(new Error("database unavailable"), { code: "08006" });
    await assert.rejects(() => appendEvent(appendInput(), executeErrorDatabase(unknown)), unknown);
    await assert.rejects(
      () => appendEvent(appendInput(), executeErrorDatabase("primitive failure")),
      (error) => error === "primitive failure",
    );
    const cyclic: { code: string; message: string; cause?: unknown } = {
      code: "P0001",
      message: "different",
    };
    cyclic.cause = cyclic;
    await assert.rejects(
      () => appendEvent(appendInput(), executeErrorDatabase(cyclic)),
      (error) => error === cyclic,
    );
  });

  it("computes envelopes with every optional representation", () => {
    const minimal = computeEnvelopeHash(appendInput());
    assert.match(minimal, /^[0-9a-f]{64}$/);
    assert.equal(hashIdempotencyKey("coverage-key"), SHA256_COVERAGE_KEY);

    const withDate = computeEnvelopeHash({
      ...appendInput(),
      specversion: "1.0",
      subject: "subject-1",
      occurredAt: new Date("2026-08-01T12:00:00.000Z"),
      datacontenttype: "application/json; charset=utf-8",
      dataschema: "https://example.test/schema",
      attributes: { traceid: "trace-1" },
    });
    const withString = computeEnvelopeHash({
      ...appendInput(),
      subject: "subject-1",
      occurredAt: "2026-08-01T12:00:00.000Z",
      dataschema: "https://example.test/schema",
      attributes: { traceid: "trace-1" },
    });
    assert.match(withDate, /^[0-9a-f]{64}$/);
    assert.match(withString, /^[0-9a-f]{64}$/);
    assert.match(
      computeEnvelopeHash({ ...appendInput(), subject: null, occurredAt: null, dataschema: null }),
      /^[0-9a-f]{64}$/,
    );
  });

  it("validates offsets, limits, cursor ordering, and exact filters", async () => {
    for (const after of [Number.MAX_SAFE_INTEGER + 1, -1, "01", "9223372036854775808"] as const) {
      await assert.rejects(
        () => listEvents({ tenantId: TENANT_ID, after }, unusedDatabase()),
        RangeError,
      );
    }
    for (const limit of [1.5, 0, 1001]) {
      await assert.rejects(
        () => listEvents({ tenantId: TENANT_ID, limit }, unusedDatabase()),
        RangeError,
      );
    }

    await assert.rejects(
      () =>
        listEvents(
          { tenantId: TENANT_ID, highWaterMark: 3n },
          selectRowsDatabase([[{ headOffset: "2" }]]),
        ),
      CursorAheadError,
    );
    await assert.rejects(
      () =>
        listEvents(
          { tenantId: TENANT_ID, after: 2n, highWaterMark: 1n },
          selectRowsDatabase([[{ headOffset: "2" }]]),
        ),
      CursorAheadError,
    );

    const invalidFilters = [
      { stream: [] },
      { stream: ["orders", ""] },
      { type: [] },
      { type: ["created", ""] },
      { source: [] },
      { source: ["urn:test", ""] },
    ] as const;
    for (const filter of invalidFilters) {
      await assert.rejects(
        () =>
          listEvents(
            { tenantId: TENANT_ID, ...filter },
            selectRowsDatabase([[{ headOffset: "0" }]]),
          ),
        RangeError,
      );
    }
  });

  it("lists pages and maps Date and string timestamp rows", async () => {
    const first = eventRow({ offset: "1", id: "one" });
    const second = eventRow({ offset: 2n, id: "two", occurredAt: "2026-08-01T11:00:00Z" });
    const page = await listEvents(
      {
        tenantId: TENANT_ID,
        after: 0,
        limit: 1,
        stream: "orders",
        type: ["com.example.created.v1"],
        source: "urn:test:coverage",
      },
      selectRowsDatabase([[{ headOffset: "2" }], [first, second]]),
    );
    assert.deepEqual(
      {
        ids: page.events.map((event) => event.id),
        after: page.after,
        nextAfter: page.nextAfter,
        highWaterMark: page.highWaterMark,
        hasMore: page.hasMore,
      },
      { ids: ["one"], after: "0", nextAfter: "1", highWaterMark: "2", hasMore: true },
    );

    const finalPage = await listEvents(
      { tenantId: TENANT_ID, after: "1", highWaterMark: "2", limit: 2 },
      selectRowsDatabase([[{ headOffset: "2" }], [[second][0]]]),
    );
    assert.equal(finalPage.hasMore, false);
    assert.equal(finalPage.nextAfter, "2");
    assert.ok(finalPage.events[0]?.occurredAt instanceof Date);
  });

  it("gets events, high-water marks, bounds, and defensive timestamp failures", async () => {
    assert.equal(await getEventByOffset(TENANT_ID, 0, unusedDatabase()), null);
    assert.equal(
      await getEventByOffset(TENANT_ID, 1, selectRowsDatabase([[]])),
      null,
    );
    const found = await getEventByOffset(
      TENANT_ID,
      1n,
      selectRowsDatabase([[eventRow({ receivedAt: "2026-08-01T12:00:00Z" })]]),
    );
    assert.equal(found?.id, "event-1");

    await assert.rejects(
      () =>
        getEventByOffset(
          TENANT_ID,
          1,
          selectRowsDatabase([[eventRow({ receivedAt: "not-a-date" })]]),
        ),
      /receivedAt from PostgreSQL is not a valid timestamp/,
    );
    await assert.rejects(
      () =>
        getEventByOffset(
          TENANT_ID,
          1,
          selectRowsDatabase([[eventRow({ occurredAt: "not-a-date" })]]),
        ),
      /occurredAt from PostgreSQL is not a valid timestamp/,
    );

    assert.equal(
      await getTenantHighWaterMark(TENANT_ID, selectRowsDatabase([[{ headOffset: "7" }]])),
      "7",
    );
    await assert.rejects(
      () => getTenantHighWaterMark(TENANT_ID, selectRowsDatabase([[]])),
      TenantNotFoundError,
    );
    assert.deepEqual(
      await getTenantEventBounds(
        TENANT_ID,
        selectRowsDatabase([[{ headOffset: "7", minimumAvailableOffset: "3" }]]),
      ),
      { headOffset: "7", minimumAvailableOffset: "3" },
    );
    await assert.rejects(
      () => getTenantEventBounds(TENANT_ID, selectRowsDatabase([[]])),
      TenantNotFoundError,
    );
  });
});

describe("PostgreSQL storage adapter edge cases", () => {
  it("maps API clients and connection secrets", async () => {
    const principal = {
      id: CLIENT_ID,
      tenantId: TENANT_ID,
      name: "coverage client",
      keyPrefix: "coverage-key",
      scopes: ["events:read", "events:write"],
      expiresAt: null,
    };
    const authenticator = new PostgresApiClientAuthenticator(updateRowsDatabase([principal]));
    assert.deepEqual(await authenticator.findActiveClientByKeyHash(SHA_A), {
      clientId: CLIENT_ID,
      tenantId: TENANT_ID,
      name: "coverage client",
      scopes: ["events:read", "events:write"],
    });
    assert.equal(
      await new PostgresApiClientAuthenticator(updateRowsDatabase([])).findActiveClientByKeyHash(SHA_A),
      undefined,
    );
    assert.deepEqual(
      await new PostgresApiClientAuthenticator(selectRowsDatabase([[principal]])).verifyActiveClientByKeyHash(
        SHA_A,
      ),
      {
        clientId: CLIENT_ID,
        tenantId: TENANT_ID,
        name: "coverage client",
        scopes: ["events:read", "events:write"],
      },
    );
    assert.equal(
      await new PostgresApiClientAuthenticator(selectRowsDatabase([[]])).verifyActiveClientByKeyHash(SHA_A),
      undefined,
    );

    const withSecret = new PostgresSourceConnectionStore(
      selectRowsDatabase([[
        {
          id: CONNECTION_ID,
          tenantId: TENANT_ID,
          provider: "hmac",
          name: "coverage",
          stream: "orders",
          signingSecret: "coverage-secret",
          config: {},
          checkpoint: null,
        },
      ]]),
    );
    assert.deepEqual(await withSecret.findActiveConnection("hmac", CONNECTION_ID), {
      id: CONNECTION_ID,
      tenantId: TENANT_ID,
      provider: "hmac",
      stream: "orders",
      signingSecret: "coverage-secret",
    });

    const withoutSecret = new PostgresSourceConnectionStore(
      selectRowsDatabase([[
        {
          id: CONNECTION_ID,
          tenantId: TENANT_ID,
          provider: "hmac",
          name: "coverage",
          stream: "orders",
          signingSecret: null,
          config: {},
          checkpoint: null,
        },
      ]]),
    );
    assert.deepEqual(await withoutSecret.findActiveConnection("hmac", CONNECTION_ID), {
      id: CONNECTION_ID,
      tenantId: TENANT_ID,
      provider: "hmac",
      stream: "orders",
    });
    assert.equal(
      await new PostgresSourceConnectionStore(selectRowsDatabase([[]])).findActiveConnection(
        "hmac",
        CONNECTION_ID,
      ),
      undefined,
    );
  });

  it("maps PostgreSQL invalid-UUID errors and rethrows every other shape", async () => {
    const invalidUuid = new PostgresSourceConnectionStore(
      selectErrorDatabase({ code: "22P02" }),
    );
    assert.equal(await invalidUuid.findActiveConnection("hmac", CONNECTION_ID), undefined);

    for (const error of [new Error("database unavailable"), null, "failure"] as const) {
      const store = new PostgresSourceConnectionStore(selectErrorDatabase(error));
      await assert.rejects(
        () => store.findActiveConnection("hmac", CONNECTION_ID),
        (actual) => actual === error,
      );
    }
  });

  it("rejects a validated event without a stream", async () => {
    const store = new PostgresEventStore(unusedDatabase());
    const event = {
      specversion: "1.0",
      id: "missing-stream",
      source: "urn:test:coverage",
      type: "com.example.created.v1",
      datacontenttype: "application/json",
      data: null,
    } satisfies CloudEvent;
    await assert.rejects(
      () => store.append({ tenantId: TENANT_ID, event, requestHash: SHA_A }),
      /Validated event is missing eventhubstream/,
    );
  });

  it("maps rich and minimal append commands to inserted and duplicate results", async () => {
    const richRow = eventRow({
      subject: "subject-1",
      occurredAt: new Date("2026-08-01T12:00:00Z"),
      dataschema: "https://example.test/schema",
      attributes: { traceid: "trace-1" },
    });
    const richStore = new PostgresEventStore(
      executeRowsDatabase([{ ...richRow, inserted: true, replayReason: null }]),
      45,
    );
    const richEvent: CloudEvent = {
      specversion: "1.0",
      id: "event-1",
      source: "urn:test:coverage",
      type: "com.example.created.v1",
      subject: "subject-1",
      time: "2026-08-01T12:00:00Z",
      datacontenttype: "application/json; charset=utf-8",
      dataschema: "https://example.test/schema",
      eventhubstream: "orders",
      traceid: "trace-1",
      dropped: undefined,
      data: { ok: true },
    };
    const inserted = await richStore.append({
      tenantId: TENANT_ID,
      event: richEvent,
      requestHash: SHA_A,
      apiClientId: CLIENT_ID,
      idempotencyKey: "request-1",
    });
    assert.equal(inserted.status, "inserted");
    assert.deepEqual(inserted.storedEvent?.event, richEventWithoutUndefined());

    const minimalRow = eventRow({ data: null });
    const minimalStore = new PostgresEventStore(
      executeRowsDatabase([{ ...minimalRow, inserted: false, replayReason: "event_identity" }]),
      1,
    );
    const duplicate = await minimalStore.append({
      tenantId: TENANT_ID,
      event: minimalEvent(),
      requestHash: SHA_B,
      idempotencyKey: "key-without-client",
    });
    assert.equal(duplicate.status, "duplicate");

    const apiOnly = await new PostgresEventStore(
      executeRowsDatabase([{ ...minimalRow, inserted: true, replayReason: null }]),
    ).append({
      tenantId: TENANT_ID,
      event: minimalEvent(),
      requestHash: SHA_A,
      apiClientId: CLIENT_ID,
    });
    assert.equal(apiOnly.status, "inserted");
  });

  it("maps append conflicts and rethrows unrelated database errors", async () => {
    const command = { tenantId: TENANT_ID, event: minimalEvent(), requestHash: SHA_A };
    const identityStore = new PostgresEventStore(
      executeErrorDatabase(databaseError("event_identity_conflict")),
    );
    assert.deepEqual(await identityStore.append(command), { status: "identity_conflict" });

    const idempotencyStore = new PostgresEventStore(
      executeErrorDatabase(databaseError("idempotency_key_conflict")),
    );
    assert.deepEqual(await idempotencyStore.append(command), { status: "idempotency_conflict" });

    const unknown = new Error("database unavailable");
    await assert.rejects(
      () => new PostgresEventStore(executeErrorDatabase(unknown)).append(command),
      unknown,
    );
  });

  it("gets offsets, lists filtered events, checks matches, and maps cursor bounds", async () => {
    const row = eventRow({ subject: null, occurredAt: null, dataschema: null });
    const store = new PostgresEventStore(
      selectRowsDatabase([
        [{ headOffset: "1" }],
        [row],
        [{ headOffset: "1" }],
        [row],
        [{ headOffset: "1" }],
        [row],
        [{ headOffset: "1" }],
        [],
        [{ headOffset: "1", minimumAvailableOffset: "1" }],
      ]),
    );
    assert.equal(await store.getByOffset(TENANT_ID, 0n), undefined);
    assert.equal((await store.getByOffset(TENANT_ID, 1n))?.offset, 1n);

    const query = {
      tenantId: TENANT_ID,
      after: 0n,
      through: 1n,
      limit: 10,
      filters: {
        stream: ["orders"],
        type: ["com.example.created.v1"],
        source: ["urn:test:coverage"],
      },
    } as const;
    assert.equal((await store.list(query)).length, 1);
    assert.equal(await store.hasMatchingEvent(query), true);
    assert.equal(await store.hasMatchingEvent({ ...query, filters: {} }), false);
    assert.deepEqual(await store.getCursorBounds(TENANT_ID), {
      headOffset: 1n,
      minimumAvailableOffset: 1n,
    });
  });

  it("returns undefined for gaps and ahead offsets, and rethrows other read errors", async () => {
    const gapStore = new PostgresEventStore(
      selectRowsDatabase([[{ headOffset: "2" }], []]),
    );
    assert.equal(await gapStore.getByOffset(TENANT_ID, 1n), undefined);

    const aheadStore = new PostgresEventStore(
      selectRowsDatabase([[{ headOffset: "0" }]]),
    );
    assert.equal(await aheadStore.getByOffset(TENANT_ID, 1n), undefined);

    const unknown = new Error("read failed");
    await assert.rejects(
      () => new PostgresEventStore(selectErrorDatabase(unknown)).getByOffset(TENANT_ID, 1n),
      unknown,
    );
  });
});

const SHA256_COVERAGE_KEY = "6a7e6c2d804024e0f42261d6e7e939e340899641aac75fe116ed5176128e585e";

function appendInput(): AppendEventInput {
  return {
    tenantId: TENANT_ID,
    stream: "orders",
    id: "event-1",
    source: "urn:test:coverage",
    type: "com.example.created.v1",
    data: { ok: true },
  };
}

type EventRowOverrides = Omit<
  Partial<DatabaseStoredEvent>,
  "offset" | "occurredAt" | "receivedAt"
> & {
  readonly offset?: string | bigint;
  readonly occurredAt?: Date | string | null;
  readonly receivedAt?: Date | string;
};

function eventRow(overrides: EventRowOverrides = {}) {
  return {
    tenantId: TENANT_ID,
    offset: "1",
    stream: "orders",
    specversion: "1.0" as const,
    id: "event-1",
    source: "urn:test:coverage",
    type: "com.example.created.v1",
    subject: null,
    occurredAt: null,
    receivedAt: new Date("2026-08-01T12:00:00.000Z"),
    datacontenttype: "application/json",
    dataschema: null,
    data: { ok: true },
    attributes: {},
    envelopeHash: SHA_A,
    ...overrides,
  };
}

function minimalEvent(): CloudEvent {
  return {
    specversion: "1.0",
    id: "event-1",
    source: "urn:test:coverage",
    type: "com.example.created.v1",
    eventhubstream: "orders",
  };
}

function richEventWithoutUndefined(): CloudEvent {
  return {
    traceid: "trace-1",
    specversion: "1.0",
    id: "event-1",
    source: "urn:test:coverage",
    type: "com.example.created.v1",
    subject: "subject-1",
    time: "2026-08-01T12:00:00.000Z",
    datacontenttype: "application/json",
    dataschema: "https://example.test/schema",
    eventhubstream: "orders",
    data: { ok: true },
  };
}

function databaseError(message: string): { readonly code: string; readonly message: string } {
  return { code: "P0001", message };
}

function unusedDatabase(): Database {
  return {} as Database;
}

function updateRowsDatabase(rows: readonly unknown[]): Database {
  return {
    update() {
      return {
        set() {
          return {
            where() {
              return {
                async returning() {
                  return rows;
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
}

function bootstrapDatabase(
  clientRows: readonly unknown[],
  connectionRows: readonly unknown[] = [],
): Database {
  let insertIndex = 0;
  const transaction = async (callback: (transaction: unknown) => Promise<unknown>) => {
    const transactionDatabase = {
      insert() {
        insertIndex += 1;
        const currentIndex = insertIndex;
        return {
          values() {
            return {
              onConflictDoNothing() {
                return Promise.resolve();
              },
              onConflictDoUpdate() {
                return {
                  async returning() {
                    return currentIndex === 3 ? clientRows : connectionRows;
                  },
                };
              },
            };
          },
        };
      },
    };
    return callback(transactionDatabase);
  };
  return { transaction } as unknown as Database;
}

function selectRowsDatabase(rowSets: readonly (readonly unknown[])[]): Database {
  let selectIndex = 0;
  return {
    select() {
      const rows = rowSets[selectIndex] ?? [];
      selectIndex += 1;
      const chain = {
        from() {
          return chain;
        },
        leftJoin() {
          return chain;
        },
        where() {
          return chain;
        },
        groupBy() {
          return chain;
        },
        orderBy() {
          return chain;
        },
        async limit() {
          return rows;
        },
      };
      return chain;
    },
  } as unknown as Database;
}

function selectErrorDatabase(error: unknown): Database {
  return {
    select() {
      throw error;
    },
  } as unknown as Database;
}

function executeRowsDatabase(rows: readonly unknown[]): Database {
  return {
    async execute() {
      return { rows };
    },
  } as unknown as Database;
}

function executeErrorDatabase(error: unknown): Database {
  return {
    async execute() {
      throw error;
    },
  } as unknown as Database;
}

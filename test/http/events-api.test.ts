import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";

import { hashApiKey } from "../../src/security/api-key.js";
import type { AppendEventCommand, EventPageQuery, EventStore } from "../../src/service/event-store.js";
import {
  createTestApp,
  storedEvent,
  TEST_CLIENT,
} from "../support/test-app.js";

describe("events HTTP API", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("publishes a CloudEvent for the authenticated tenant", async () => {
    let command: AppendEventCommand | undefined;
    const eventStore = eventStoreStub({
      async append(input) {
        command = input;
        return { status: "inserted", storedEvent: storedEvent(42n) };
      },
    });
    app = await createTestApp({ eventStore });
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: {
        authorization: "Bearer test-api-key",
        "content-type": "application/cloudevents+json",
        "idempotency-key": "publish-order-42",
      },
      payload: JSON.stringify({
        specversion: "1.0",
        id: "event-42",
        source: "urn:test:publisher",
        type: "com.example.order.created.v1",
        datacontenttype: "application/json",
        eventhubstream: "orders",
        data: { order_id: "order-42" },
      }),
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.headers.location, "/v1/events/42");
    assert.match(String(response.headers["content-type"]), /^application\/cloudevents\+json/);
    assert.equal(typeof response.headers["x-request-id"], "string");
    assert.equal(command?.tenantId, TEST_CLIENT.tenantId);
    assert.equal(command?.apiClientId, TEST_CLIENT.clientId);
    assert.equal(command?.idempotencyKey, "publish-order-42");
    assert.match(command?.requestHash ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(response.json(), {
      specversion: "1.0",
      id: "event-42",
      source: "urn:test:publisher",
      type: "com.example.order.created.v1",
      datacontenttype: "application/json",
      eventhubstream: "orders",
      data: { order_id: "order-42" },
      eventhuboffset: "42",
      eventhubreceivedat: "2026-08-01T13:20:00.000Z",
    });
  });

  it("returns an explicit replay response for a duplicate publish", async () => {
    const eventStore = eventStoreStub({
      async append() {
        return { status: "duplicate", storedEvent: storedEvent(42n) };
      },
    });
    app = await createTestApp({ eventStore });
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: {
        authorization: "Bearer test-api-key",
        "content-type": "application/cloudevents+json",
      },
      payload: JSON.stringify({
        specversion: "1.0",
        id: "event-42",
        source: "urn:test:publisher",
        type: "com.example.order.created.v1",
        datacontenttype: "application/json",
        eventhubstream: "orders",
        data: { order_id: "order-42" },
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["idempotent-replayed"], "true");
  });

  it("uses the path-specific error code for an invalid event offset", async () => {
    app = await createTestApp({ eventStore: eventStoreStub({}) });
    const response = await app.inject({
      method: "GET",
      url: "/v1/events/not-an-offset",
      headers: { authorization: "Bearer test-api-key" },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "invalid_offset");

    const zero = await app.inject({
      method: "GET",
      url: "/v1/events/0",
      headers: { authorization: "Bearer test-api-key" },
    });
    assert.equal(zero.statusCode, 400);
    assert.equal(zero.json().code, "invalid_offset");
  });

  it("maps PostgreSQL network failures to storage_unavailable", async () => {
    app = await createTestApp({
      eventStore: eventStoreStub({}),
      apiClientAuthenticator: {
        async findActiveClientByKeyHash() {
          throw new Error("Drizzle query failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED"), {
              code: "ECONNREFUSED",
            }),
          });
        },
        async verifyActiveClientByKeyHash() {
          return TEST_CLIENT;
        },
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: { authorization: "Bearer test-api-key" },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "storage_unavailable");
  });

  it("uses repeated filters as OR values and never accepts a caller-supplied tenant", async () => {
    let query: EventPageQuery | undefined;
    const eventStore = eventStoreStub({
      async list(input) {
        query = input;
        return [storedEvent(4n)];
      },
      async getCursorBounds() {
        return { headOffset: 9n, minimumAvailableOffset: 1n };
      },
    });
    app = await createTestApp({ eventStore });
    const response = await app.inject({
      method: "GET",
      url:
        "/v1/events?after=1&limit=2&stream=orders&stream=payments" +
        "&type=com.example.order.created.v1&tenant_id=other-tenant",
      headers: { authorization: "Bearer test-api-key" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(query?.tenantId, TEST_CLIENT.tenantId);
    assert.equal(query?.after, 1n);
    assert.equal(query?.through, 9n);
    assert.deepEqual(query?.filters, {
      stream: ["orders", "payments"],
      type: "com.example.order.created.v1",
    });
    assert.deepEqual(response.json().page, {
      after: "1",
      next_after: "9",
      head_offset: "9",
      minimum_available_offset: "1",
      has_more: false,
    });
  });

  it("returns retained bounds for an expired cursor but keeps after=0 as a sentinel", async () => {
    let listCalls = 0;
    const eventStore = eventStoreStub({
      async list() {
        listCalls += 1;
        return [];
      },
      async getCursorBounds() {
        return { headOffset: 20n, minimumAvailableOffset: 10n };
      },
    });
    app = await createTestApp({ eventStore });

    const expired = await app.inject({
      method: "GET",
      url: "/v1/events?after=5",
      headers: { authorization: "Bearer test-api-key" },
    });
    assert.equal(expired.statusCode, 410);
    assert.equal(expired.json().code, "cursor_expired");
    assert.equal(expired.json().minimum_available_offset, "10");
    assert.equal(expired.json().head_offset, "20");
    assert.equal(listCalls, 0);

    const fromBeginning = await app.inject({
      method: "GET",
      url: "/v1/events?after=0",
      headers: { authorization: "Bearer test-api-key" },
    });
    assert.equal(fromBeginning.statusCode, 200);
    assert.equal(fromBeginning.json().page.next_after, "20");
    assert.equal(listCalls, 1);
  });

  it("does not silently skip events if retention advances during a history read", async () => {
    let boundsCalls = 0;
    const eventStore = eventStoreStub({
      async list() {
        return [];
      },
      async getCursorBounds() {
        boundsCalls += 1;
        return boundsCalls === 1
          ? { headOffset: 20n, minimumAvailableOffset: 10n }
          : { headOffset: 20n, minimumAvailableOffset: 15n };
      },
    });
    app = await createTestApp({ eventStore });
    const response = await app.inject({
      method: "GET",
      url: "/v1/events?after=9",
      headers: { authorization: "Bearer test-api-key" },
    });

    assert.equal(response.statusCode, 410);
    assert.equal(response.json().code, "cursor_expired");
    assert.equal(response.json().minimum_available_offset, "15");
  });

  it("uses Last-Event-ID ahead of the initial after query for SSE reconnects", async () => {
    let listCalls = 0;
    const eventStore = eventStoreStub({
      async list() {
        listCalls += 1;
        return [];
      },
      async getCursorBounds() {
        return { headOffset: 10n, minimumAvailableOffset: 1n };
      },
    });
    app = await createTestApp({ eventStore });
    const response = await requestSse(app, "/v1/events/stream?after=2", {
        authorization: "Bearer test-api-key",
        accept: "text/event-stream",
        "last-event-id": "10",
    });

    assert.equal(response.status, 200);
    assert.match(response.contentType, /^text\/event-stream/);
    assert.equal(response.body, "retry: 3000\n\n");
    assert.equal(listCalls, 0);
  });

  it("uses after=0 to replay retained SSE events without fabricating checkpoint events", async () => {
    let observedQuery: EventPageQuery | undefined;
    const eventStore = eventStoreStub({
      async list(query) {
        observedQuery = query;
        return [storedEvent(10n)];
      },
      async getCursorBounds() {
        return { headOffset: 12n, minimumAvailableOffset: 10n };
      },
    });
    app = await createTestApp({ eventStore });
    const response = await requestSse(app, "/v1/events/stream?after=0", {
        authorization: "Bearer test-api-key",
        accept: "text/event-stream",
    });

    assert.equal(response.status, 200);
    assert.equal(observedQuery?.after, 0n);
    assert.equal(observedQuery?.through, 12n);
    assert.match(response.body, /id: 10\nevent: com\.example\.order\.created\.v1\n/);
    assert.match(response.body, /"eventhuboffset":"10"/);
    assert.doesNotMatch(response.body, /eventhub\.checkpoint/);
  });

  it("closes an SSE stream before it sends an event after its credential is invalidated", async () => {
    let verificationCount = 0;
    let verifiedHash: string | undefined;
    let listCalls = 0;
    const eventStore = eventStoreStub({
      async list() {
        listCalls += 1;
        return [storedEvent(1n)];
      },
      async getCursorBounds() {
        return { headOffset: 1n, minimumAvailableOffset: 1n };
      },
    });
    app = await createTestApp({
      eventStore,
      apiClientAuthenticator: {
        async findActiveClientByKeyHash() {
          return TEST_CLIENT;
        },
        async verifyActiveClientByKeyHash(keyHash) {
          verifiedHash = keyHash;
          verificationCount += 1;
          // The third check happens immediately before the first business event,
          // modelling a rotation or revocation while a backlog is being sent.
          return verificationCount < 3 ? TEST_CLIENT : undefined;
        },
      },
    });

    const response = await requestSse(app, "/v1/events/stream?after=0", {
      authorization: "Bearer test-api-key",
      accept: "text/event-stream",
    });

    assert.equal(verifiedHash, hashApiKey("test-api-key"));
    assert.equal(verificationCount, 3);
    assert.equal(listCalls, 1);
    assert.equal(response.body, "retry: 3000\n\n");
  });

  it("stops an SSE backlog before the next batch when its credential is invalidated", async () => {
    let verificationCount = 0;
    let listCalls = 0;
    app = await createTestApp({
      eventStore: eventStoreStub({
        async list() {
          listCalls += 1;
          return [storedEvent(1n)];
        },
        async getCursorBounds() {
          return { headOffset: 1n, minimumAvailableOffset: 1n };
        },
      }),
      apiClientAuthenticator: {
        async findActiveClientByKeyHash() {
          return TEST_CLIENT;
        },
        async verifyActiveClientByKeyHash() {
          verificationCount += 1;
          return verificationCount === 1 ? TEST_CLIENT : undefined;
        },
      },
    });

    const response = await requestSse(app, "/v1/events/stream?after=0", {
      authorization: "Bearer test-api-key",
      accept: "text/event-stream",
    });

    assert.equal(verificationCount, 2);
    assert.equal(listCalls, 0);
    assert.equal(response.body, "retry: 3000\n\n");
  });

  it("closes an SSE stream when its credential no longer has events:read", async () => {
    let listCalls = 0;
    app = await createTestApp({
      eventStore: eventStoreStub({
        async list() {
          listCalls += 1;
          return [];
        },
      }),
      apiClientAuthenticator: {
        async findActiveClientByKeyHash() {
          return TEST_CLIENT;
        },
        async verifyActiveClientByKeyHash() {
          return { ...TEST_CLIENT, scopes: ["events:write"] };
        },
      },
    });

    const response = await requestSse(app, "/v1/events/stream?after=0", {
      authorization: "Bearer test-api-key",
      accept: "text/event-stream",
    });

    assert.equal(listCalls, 0);
    assert.equal(response.body, "retry: 3000\n\n");
  });

  it("closes active SSE responses during graceful application shutdown", { timeout: 2000 }, async () => {
    app = await createTestApp({
      eventStore: eventStoreStub({}),
      notifier: {
        waitForTenant(_tenantId, _timeoutMs, signal) {
          return new Promise<"aborted">((resolve) => {
            if (signal?.aborted === true) {
              resolve("aborted");
              return;
            }
            signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
          });
        },
      },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/v1/events/stream`, {
      headers: {
        authorization: "Bearer test-api-key",
        accept: "text/event-stream",
      },
    });

    assert.equal(response.status, 200);
    await app.close();
    assert.equal(await response.text(), "retry: 3000\n\n");
    app = undefined;
  });
});

function eventStoreStub(overrides: Partial<EventStore>): EventStore {
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
    ...overrides,
  };
}

async function requestSse(
  app: FastifyInstance,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ status: number; contentType: string; body: string }> {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${address}${path}`, { headers });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
}

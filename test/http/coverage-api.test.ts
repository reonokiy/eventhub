import assert from "node:assert/strict";
import { ServerResponse, type IncomingMessage } from "node:http";
import { afterEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import { buildApp } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import type { Database } from "../../src/db/database.js";
import { CloudEventValidationError } from "../../src/domain/cloud-event.js";
import { CursorValidationError } from "../../src/domain/cursor.js";
import { EventFilterValidationError } from "../../src/domain/filters.js";
import { HttpError } from "../../src/http/errors.js";
import { parseJsonBody } from "../../src/http/raw-body.js";
import { generateRequestId } from "../../src/http/request-id.js";
import { mapPathOffsetError } from "../../src/http/routes/events.js";
import { mapHmacWebhookError } from "../../src/http/routes/webhooks.js";
import type { ApiClientAuthenticator } from "../../src/http/auth.js";
import type { EventNotifier } from "../../src/realtime/notifier.js";
import { createWebhookSignature } from "../../src/security/webhook-signature.js";
import type { SourceConnectionStore } from "../../src/service/connections.js";
import type {
  AppendEventCommand,
  EventPageQuery,
  EventStore,
} from "../../src/service/event-store.js";
import {
  storedEvent,
  TEST_CLIENT,
} from "../support/test-app.js";

const BASE_CONFIG = loadConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgres://unused/coverage-tests",
});

const VALID_EVENT = {
  specversion: "1.0",
  id: "coverage-event",
  source: "urn:test:coverage",
  type: "com.example.coverage.v1",
  datacontenttype: "application/json",
  eventhubstream: "coverage",
  data: { covered: true },
} as const;

const openApps = new Set<FastifyInstance>();

afterEach(async () => {
  await Promise.all([...openApps].map(async (app) => app.close()));
  openApps.clear();
});

describe("HTTP coverage completion", () => {
  it("serves discovery and health endpoints, including an unavailable readiness check", async () => {
    const healthy = await createCoverageApp({
      eventStore: eventStoreStub(),
      database: databaseStub(),
    });

    const root = await healthy.inject({ method: "GET", url: "/" });
    assert.equal(root.statusCode, 200);
    assert.deepEqual(root.json(), {
      service: "eventhub",
      version: "0.1.0",
      specification: "spec/",
    });

    const live = await healthy.inject({ method: "GET", url: "/health/live" });
    assert.deepEqual(live.json(), { status: "ok" });

    const ready = await healthy.inject({ method: "GET", url: "/health/ready" });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { status: "ok" });

    const unavailable = await createCoverageApp({
      eventStore: eventStoreStub(),
      database: databaseStub(new Error("database unavailable")),
    });
    const unavailableReady = await unavailable.inject({ method: "GET", url: "/health/ready" });
    assert.equal(unavailableReady.statusCode, 503);
    assert.deepEqual(unavailableReady.json(), { status: "unavailable" });
  });

  it("uses the caller request id, generates safe fallbacks, and preserves a route header", async () => {
    assert.equal(
      generateRequestId(requestWithId(["array-request-id", "ignored"])),
      "array-request-id",
    );
    assert.equal(generateRequestId(requestWithId("valid:id.42")), "valid:id.42");
    assert.match(generateRequestId(requestWithId("not valid")), /^req_[0-9a-f-]{36}$/);
    assert.match(generateRequestId(requestWithId(undefined)), /^req_[0-9a-f-]{36}$/);

    const app = await createCoverageApp({ eventStore: eventStoreStub() });
    app.get("/coverage/request-id", async (_request, reply) => {
      reply.header("X-Request-ID", "route-selected-id");
      return { ok: true };
    });
    const response = await app.inject({
      method: "GET",
      url: "/coverage/request-id",
      headers: { "x-request-id": "incoming-id" },
    });
    assert.equal(response.headers["x-request-id"], "route-selected-id");
  });

  it("formats problem details with and without optional extensions", () => {
    const minimal = new HttpError(400, "bad_request", "Bad request").toBody("request-1");
    assert.deepEqual(minimal, {
      type: "https://eventhub.local/problems/bad-request",
      title: "Bad request",
      status: 400,
      code: "bad_request",
      detail: "Bad request",
      request_id: "request-1",
    });

    const extended = new HttpError(
      410,
      "cursor_expired",
      "Expired",
      ["first", "second"],
      { head_offset: "9" },
    ).toBody("request-2");
    assert.deepEqual(extended.errors, ["first", "second"]);
    assert.equal(extended.head_offset, "9");
  });

  it("rejects a body that did not pass through the raw byte parser", () => {
    assert.throws(() => parseJsonBody({ parsed: true }), {
      name: "SyntaxError",
      message: "Request body was not parsed as JSON bytes",
    });
  });

  it("maps domain, Fastify, PostgreSQL, and unknown errors to stable problem responses", async () => {
    const app = await createCoverageApp({ eventStore: eventStoreStub() });
    app.get("/coverage/error/:kind", async (request) => {
      const { kind } = request.params as { kind: string };
      throw coverageError(kind);
    });

    const expectations: ReadonlyArray<readonly [string, number, string]> = [
      ["cloud-event", 400, "invalid_event"],
      ["cloud-event-empty", 400, "invalid_event"],
      ["cursor", 400, "invalid_cursor"],
      ["filter", 400, "invalid_filter"],
      ["syntax", 400, "invalid_json"],
      ["fastify-large", 413, "payload_too_large"],
      ["status-large", 413, "payload_too_large"],
      ["fastify-media", 415, "unsupported_media_type"],
      ["status-media", 415, "unsupported_media_type"],
      ["pg-class", 503, "storage_unavailable"],
      ["pg-shutdown", 503, "storage_unavailable"],
      ["pg-crash", 503, "storage_unavailable"],
      ["pg-cannot-connect", 503, "storage_unavailable"],
      ["pg-network", 503, "storage_unavailable"],
      ["pg-message", 503, "storage_unavailable"],
      ["pg-nested", 503, "storage_unavailable"],
      ["unknown", 500, "internal_error"],
      ["cycle", 500, "internal_error"],
      ["primitive-cause", 500, "internal_error"],
    ];

    for (const [kind, status, code] of expectations) {
      const response = await app.inject({ method: "GET", url: `/coverage/error/${kind}` });
      assert.equal(response.statusCode, status, kind);
      assert.equal(response.json().code, code, kind);
    }
    assert.equal(
      (await app.inject({ method: "GET", url: "/coverage/error/cloud-event-empty" })).json()
        .detail,
      "CloudEvent validation failed",
    );
  });

  it("returns the explicit not-found problem document", async () => {
    const app = await createCoverageApp({ eventStore: eventStoreStub() });
    const response = await app.inject({ method: "GET", url: "/does-not-exist" });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers["content-type"], "application/problem+json; charset=utf-8");
    assert.equal(response.json().code, "not_found");
  });

  it("constructs and closes its default adapters and owned PostgreSQL notifier", async () => {
    const queries: string[] = [];
    const released: boolean[] = [];
    const listener = fakePoolClient(queries, released);
    const pool = {
      async connect() {
        return listener;
      },
      async query() {
        return { rows: [{ ok: 1 }], rowCount: 1 };
      },
    } as unknown as Pool;

    const app = await trackApp(buildApp({ config: BASE_CONFIG, pool }));
    assert.ok(queries.includes("LISTEN eventhub_events"));
    await app.close();
    openApps.delete(app);
    assert.ok(queries.includes("UNLISTEN eventhub_events"));
    assert.deepEqual(released, [false]);
  });

  it("maps publish conflicts, malformed payloads, invalid idempotency keys, and store invariants", async () => {
    for (const [status, expectedCode] of [
      ["identity_conflict", "event_identity_conflict"],
      ["idempotency_conflict", "idempotency_key_conflict"],
    ] as const) {
      const app = await createCoverageApp({
        eventStore: eventStoreStub({
          async append() {
            return { status };
          },
        }),
      });
      const response = await publish(app, VALID_EVENT);
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().code, expectedCode);
    }

    const invariantApp = await createCoverageApp({
      eventStore: eventStoreStub({
        async append() {
          return { status: "inserted" };
        },
      }),
    });
    const invariant = await publish(invariantApp, VALID_EVENT);
    assert.equal(invariant.statusCode, 500);
    assert.equal(invariant.json().code, "internal_error");

    const validationApp = await createCoverageApp({ eventStore: eventStoreStub() });
    const invalidEvent = await publish(validationApp, { ...VALID_EVENT, id: "" });
    assert.equal(invalidEvent.statusCode, 400);
    assert.equal(invalidEvent.json().code, "invalid_event");

    const malformedJson = await validationApp.inject({
      method: "POST",
      url: "/v1/events",
      headers: {
        authorization: "Bearer test-api-key",
        "content-type": "application/cloudevents+json",
      },
      payload: "{",
    });
    assert.equal(malformedJson.statusCode, 400);
    assert.equal(malformedJson.json().code, "invalid_json");

    for (const key of ["   ", "\u001f", "x".repeat(256)]) {
      const response = await publish(validationApp, VALID_EVENT, key);
      assert.equal(response.statusCode, 400, JSON.stringify(key));
      assert.equal(response.json().code, "invalid_idempotency_key");
    }
  });

  it("maps parser size and media-type errors", async () => {
    const app = await createCoverageApp({
      eventStore: eventStoreStub(),
      config: config({ maxEventBytes: 1024 }),
    });
    const tooLarge = await publish(app, {
      ...VALID_EVENT,
      data: { text: "x".repeat(2048) },
    });
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(tooLarge.json().code, "payload_too_large");

    const unsupported = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: {
        authorization: "Bearer test-api-key",
        "content-type": "application/octet-stream",
      },
      payload: "bytes",
    });
    assert.equal(unsupported.statusCode, 415);
    assert.equal(unsupported.json().code, "unsupported_media_type");
  });

  it("returns an event by offset and distinguishes missing, ahead, and invalid filters", async () => {
    const foundApp = await createCoverageApp({
      eventStore: eventStoreStub({
        async getByOffset(_tenantId, offset) {
          return storedEvent(offset);
        },
      }),
    });
    const found = await foundApp.inject({
      method: "GET",
      url: "/v1/events/7",
      headers: authorizationHeader(),
    });
    assert.equal(found.statusCode, 200);
    assert.equal(found.json().eventhuboffset, "7");

    const missingApp = await createCoverageApp({ eventStore: eventStoreStub() });
    const missing = await missingApp.inject({
      method: "GET",
      url: "/v1/events/7",
      headers: authorizationHeader(),
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().code, "event_not_found");

    const aheadApp = await createCoverageApp({
      eventStore: eventStoreStub({
        async getCursorBounds() {
          return { headOffset: 5n, minimumAvailableOffset: 1n };
        },
      }),
    });
    const ahead = await aheadApp.inject({
      method: "GET",
      url: "/v1/events?after=6",
      headers: authorizationHeader(),
    });
    assert.equal(ahead.statusCode, 400);
    assert.equal(ahead.json().code, "cursor_ahead");

    const invalidFilter = await aheadApp.inject({
      method: "GET",
      url: "/v1/events?stream=",
      headers: authorizationHeader(),
    });
    assert.equal(invalidFilter.statusCode, 400);
    assert.equal(invalidFilter.json().code, "invalid_filter");
  });

  it("covers both full-page continuations and the defensive empty-tail fallback", async () => {
    for (const hasMatching of [true, false]) {
      let matchingQuery: EventPageQuery | undefined;
      const app = await createCoverageApp({
        eventStore: eventStoreStub({
          async list() {
            return [storedEvent(4n)];
          },
          async hasMatchingEvent(query) {
            matchingQuery = query;
            return hasMatching;
          },
          async getCursorBounds() {
            return { headOffset: 9n, minimumAvailableOffset: 1n };
          },
        }),
      });
      const response = await app.inject({
        method: "GET",
        url: "/v1/events?after=1&limit=1",
        headers: authorizationHeader(),
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().page.has_more, hasMatching);
      assert.equal(response.json().page.next_after, hasMatching ? "4" : "9");
      assert.equal(matchingQuery?.after, 4n);
    }

    const unusualPage = [storedEvent(4n)];
    unusualPage.at = () => undefined;
    const fallbackApp = await createCoverageApp({
      eventStore: eventStoreStub({
        async list() {
          return unusualPage;
        },
        async hasMatchingEvent() {
          return true;
        },
        async getCursorBounds() {
          return { headOffset: 9n, minimumAvailableOffset: 1n };
        },
      }),
    });
    const fallback = await fallbackApp.inject({
      method: "GET",
      url: "/v1/events?after=1&limit=1",
      headers: authorizationHeader(),
    });
    assert.equal(fallback.statusCode, 200);
    assert.equal(fallback.json().page.next_after, "1");
  });

  it("validates SSE Accept headers and cursors before hijacking the response", async () => {
    const app = await createCoverageApp({
      eventStore: eventStoreStub({
        async getCursorBounds() {
          return { headOffset: 10n, minimumAvailableOffset: 5n };
        },
      }),
    });

    const unacceptable = await app.inject({
      method: "GET",
      url: "/v1/events/stream",
      headers: { ...authorizationHeader(), accept: "application/json" },
    });
    assert.equal(unacceptable.statusCode, 406);
    assert.equal(unacceptable.json().code, "not_acceptable");

    const expired = await app.inject({
      method: "GET",
      url: "/v1/events/stream?after=2",
      headers: { ...authorizationHeader(), accept: "text/event-stream" },
    });
    assert.equal(expired.statusCode, 410);

    const ahead = await app.inject({
      method: "GET",
      url: "/v1/events/stream?after=11",
      headers: { ...authorizationHeader(), accept: "text/event-stream" },
    });
    assert.equal(ahead.statusCode, 400);
    assert.equal(ahead.json().code, "cursor_ahead");

    const invalidHeader = await app.inject({
      method: "GET",
      url: "/v1/events/stream",
      headers: {
        ...authorizationHeader(),
        accept: "text/event-stream",
        "last-event-id": "invalid",
      },
    });
    assert.equal(invalidHeader.statusCode, 400);
    assert.equal(invalidHeader.json().code, "invalid_cursor");
  });

  it("accepts absent, wildcard, and parameterized SSE Accept values and defaults to the head", async () => {
    for (const accept of [undefined, "*/*", "application/json, text/event-stream; charset=utf-8"]) {
      let listCalls = 0;
      const app = await createCoverageApp({
        eventStore: eventStoreStub({
          async list() {
            listCalls += 1;
            return [];
          },
          async getCursorBounds() {
            return { headOffset: 5n, minimumAvailableOffset: 1n };
          },
        }),
      });
      const response = await requestSse(
        app,
        "/v1/events/stream",
        accept === undefined ? authorizationHeader() : { ...authorizationHeader(), accept },
      );
      assert.equal(response.status, 200);
      assert.equal(response.body, "retry: 3000\n\n");
      assert.equal(listCalls, 0);
    }
  });

  it("emits heartbeats after poll wakes", async () => {
    let waits = 0;
    const notifier: EventNotifier = {
      async waitForTenant() {
        waits += 1;
        return waits === 1 ? "poll" : "aborted";
      },
    };
    const app = await createCoverageApp({
      eventStore: eventStoreStub(),
      notifier,
      config: config({ sseHeartbeatIntervalMs: 0 }),
    });
    const response = await requestSse(app, "/v1/events/stream?after=0", {
      ...authorizationHeader(),
      accept: "text/event-stream",
    });
    assert.match(response.body, /^retry: 3000\n\n: keepalive\n\n$/);
  });

  it("closes an SSE stream if its cursor expires while the connection is active", async () => {
    let boundsCalls = 0;
    const app = await createCoverageApp({
      eventStore: eventStoreStub({
        async getCursorBounds() {
          boundsCalls += 1;
          return boundsCalls === 1
            ? { headOffset: 20n, minimumAvailableOffset: 10n }
            : { headOffset: 20n, minimumAvailableOffset: 15n };
        },
      }),
    });
    const response = await requestSse(app, "/v1/events/stream?after=9", {
      ...authorizationHeader(),
      accept: "text/event-stream",
    });
    assert.equal(response.body, "retry: 3000\n\n");
    assert.ok(boundsCalls >= 2);
  });

  it("streams exact and short batches and advances across filtered gaps", async () => {
    let listCalls = 0;
    const app = await createCoverageApp({
      eventStore: eventStoreStub({
        async list() {
          listCalls += 1;
          return listCalls === 1 ? [storedEvent(1n)] : [];
        },
        async getCursorBounds() {
          return { headOffset: 2n, minimumAvailableOffset: 1n };
        },
      }),
      config: config({ sseBatchSize: 1 }),
    });
    const response = await requestSse(app, "/v1/events/stream?after=0", {
      ...authorizationHeader(),
      accept: "text/event-stream",
    });
    assert.match(response.body, /id: 1\n/);
    assert.equal(listCalls, 2);

    const atHeadApp = await createCoverageApp({
      eventStore: eventStoreStub({
        async list() {
          return [storedEvent(1n)];
        },
        async getCursorBounds() {
          return { headOffset: 1n, minimumAvailableOffset: 1n };
        },
      }),
      config: config({ sseBatchSize: 2 }),
    });
    const atHead = await requestSse(atHeadApp, "/v1/events/stream?after=0", {
      ...authorizationHeader(),
      accept: "text/event-stream",
    });
    assert.match(atHead.body, /id: 1\n/);
  });

  it("closes SSE on a retention race or event-store exception without changing the HTTP status", async () => {
    let boundsCalls = 0;
    const retentionRace = await createCoverageApp({
      eventStore: eventStoreStub({
        async list() {
          return [storedEvent(2n)];
        },
        async getCursorBounds() {
          boundsCalls += 1;
          return boundsCalls < 3
            ? { headOffset: 2n, minimumAvailableOffset: 1n }
            : { headOffset: 2n, minimumAvailableOffset: 3n };
        },
      }),
    });
    const expired = await requestSse(retentionRace, "/v1/events/stream?after=1", {
      ...authorizationHeader(),
      accept: "text/event-stream",
    });
    assert.equal(expired.status, 200);
    assert.equal(expired.body, "retry: 3000\n\n");

    const failedStore = await createCoverageApp({
      eventStore: eventStoreStub({
        async list() {
          throw new Error("stream read failed");
        },
        async getCursorBounds() {
          return { headOffset: 1n, minimumAvailableOffset: 1n };
        },
      }),
    });
    const failed = await requestSse(failedStore, "/v1/events/stream?after=0", {
      ...authorizationHeader(),
      accept: "text/event-stream",
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.body, "retry: 3000\n\n");
  });

  it("handles SSE backpressure by waiting for drain", async () => {
    const restore = patchResponseWrite(function (original, args) {
      const written = original.apply(this, args);
      queueMicrotask(() => this.emit("drain"));
      return written && false;
    });
    try {
      const app = await createCoverageApp({
        eventStore: eventStoreStub({
          async list() {
            return [storedEvent(1n)];
          },
          async getCursorBounds() {
            return { headOffset: 1n, minimumAvailableOffset: 1n };
          },
        }),
      });
      const response = await requestSse(app, "/v1/events/stream?after=0", {
        ...authorizationHeader(),
        accept: "text/event-stream",
      });
      assert.match(response.body, /id: 1\n/);
    } finally {
      restore();
    }
  });

  it("times out an SSE write that never drains", async () => {
    const restore = patchResponseWrite(function () {
      return false;
    });
    try {
      const app = await createCoverageApp({
        eventStore: eventStoreStub(),
        config: config({ sseWriteTimeoutMs: 1 }),
      });
      const response = await requestSse(app, "/v1/events/stream?after=0", {
        ...authorizationHeader(),
        accept: "text/event-stream",
      });
      assert.equal(response.status, 200);
      assert.equal(response.body, "");
    } finally {
      restore();
    }
  });

  it("rejects an SSE frame larger than the pending-buffer guard", async () => {
    const huge = storedEvent(1n, { data: { text: "x".repeat(1_048_576) } });
    const app = await createCoverageApp({
      eventStore: eventStoreStub({
        async list() {
          return [huge];
        },
        async getCursorBounds() {
          return { headOffset: 1n, minimumAvailableOffset: 1n };
        },
      }),
    });
    const response = await requestSse(app, "/v1/events/stream?after=0", {
      ...authorizationHeader(),
      accept: "text/event-stream",
    });
    assert.equal(response.body, "retry: 3000\n\n");
  });

  it("closes an SSE stream whose response becomes writable-ended between frames", async () => {
    let writes = 0;
    const restore = patchResponseWrite(function (original, arguments_) {
      const result = original.apply(this, arguments_);
      writes += 1;
      if (writes === 1) {
        let writableEndedReads = 0;
        Object.defineProperty(this, "writableEnded", {
          configurable: true,
          get() {
            writableEndedReads += 1;
            return writableEndedReads === 1;
          },
        });
      }
      return result;
    });
    try {
      const app = await createCoverageApp({
        eventStore: eventStoreStub({
          async list() {
            return [storedEvent(1n)];
          },
          async getCursorBounds() {
            return { headOffset: 1n, minimumAvailableOffset: 1n };
          },
        }),
      });
      const response = await requestSse(app, "/v1/events/stream?after=0", {
        ...authorizationHeader(),
        accept: "text/event-stream",
      });
      assert.equal(response.status, 200);
      assert.equal(response.body, "retry: 3000\n\n");
      assert.equal(writes, 1);
    } finally {
      restore();
    }
  });

  it("preserves unexpected path cursor parser failures", () => {
    const error = new Error("unexpected parser failure");
    assert.throws(
      () => mapPathOffsetError(error),
      (thrown: unknown) => thrown === error,
    );
  });

  it("validates webhook routing and connection invariants", async () => {
    const noConnection = await createCoverageApp({ eventStore: eventStoreStub() });
    for (const path of [
      "/v1/webhooks/INVALID/connection",
      "/v1/webhooks/github/connection",
      "/v1/webhooks/hmac/connection",
    ]) {
      const response = await noConnection.inject({
        method: "POST",
        url: path,
        headers: { "content-type": "application/json" },
        payload: "{}",
      });
      assert.equal(response.statusCode, 404, path);
      assert.equal(response.json().code, "connection_not_found");
    }

    const unsigned = await createCoverageApp({
      eventStore: eventStoreStub(),
      connectionStore: connectionStore(undefined),
    });
    const response = await unsigned.inject({
      method: "POST",
      url: "/v1/webhooks/hmac/connection",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    assert.equal(response.statusCode, 404);
  });

  it("rejects a webhook when the raw body invariant is broken", async () => {
    const app = await createCoverageApp({
      eventStore: eventStoreStub(),
      connectionStore: connectionStore("webhook-secret-long-enough"),
    });
    app.addHook("preHandler", async (request) => {
      if (request.url.startsWith("/v1/webhooks/")) {
        delete request.rawBody;
      }
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/hmac/connection",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, "connection_not_found");
  });

  it("maps webhook append outcomes and accepts optional subject and time", async () => {
    for (const [status, expectedStatus, expectedCode] of [
      ["identity_conflict", 409, "event_identity_conflict"],
      ["idempotency_conflict", 500, "internal_error"],
    ] as const) {
      const app = await signedWebhookApp({
        async append() {
          return { status };
        },
      });
      const response = await sendSignedWebhook(app, webhookPayload());
      assert.equal(response.statusCode, expectedStatus);
      assert.equal(response.json().code, expectedCode);
    }

    const missingStored = await signedWebhookApp({
      async append() {
        return { status: "duplicate" };
      },
    });
    assert.equal((await sendSignedWebhook(missingStored, webhookPayload())).statusCode, 500);

    let appended: AppendEventCommand | undefined;
    const duplicate = await signedWebhookApp({
      async append(command) {
        appended = command;
        return {
          status: "duplicate",
          storedEvent: storedEvent(2n, {
            id: "webhook-id",
            source: "urn:eventhub:hmac:connection",
            type: "com.example.webhook.v1",
            eventhubstream: "webhooks",
          }),
        };
      },
    });
    const response = await sendSignedWebhook(
      duplicate,
      webhookPayload({ subject: "subject-1", time: "2026-08-01T13:20:00+02:00" }),
    );
    assert.equal(response.statusCode, 200);
    assert.equal(appended?.event.subject, "subject-1");
    assert.equal(appended?.event.time, "2026-08-01T11:20:00.000Z");
  });

  it("maps malformed webhook JSON, shape errors, unknown fields, and CloudEvent errors", async () => {
    const app = await signedWebhookApp({
      async append() {
        throw new Error("append must not run");
      },
    });

    const cases: ReadonlyArray<Buffer | string> = [
      Buffer.from([0xc3, 0x28]),
      "{",
      "[]",
      JSON.stringify({ id: "id", type: "type", data: null, extra: true }),
      JSON.stringify({ id: "id", type: "type" }),
      JSON.stringify({ id: "", type: "com.example.webhook.v1", data: null }),
    ];
    for (const payload of cases) {
      const response = await sendSignedWebhook(app, payload);
      assert.equal(response.statusCode, 400, payload.toString());
      assert.equal(response.json().code, "invalid_webhook");
    }
  });

  it("rethrows unexpected signature failures as internal errors", async () => {
    const app = await createCoverageApp({
      eventStore: eventStoreStub(),
      connectionStore: {
        async findActiveConnection() {
          return {
            id: "connection",
            tenantId: TEST_CLIENT.tenantId,
            provider: "hmac",
            stream: "webhooks",
            signingSecret: null as unknown as string,
          };
        },
      },
    });
    const body = JSON.stringify(webhookPayload());
    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/hmac/connection",
      headers: {
        "content-type": "application/json",
        "x-eventhub-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-eventhub-signature": `v1=${"0".repeat(64)}`,
      },
      payload: body,
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().code, "internal_error");
  });

  it("uses the webhook validation fallback when an error contains no first detail", () => {
    const mapped = mapHmacWebhookError(new CloudEventValidationError([]));
    assert.equal(mapped.statusCode, 400);
    assert.equal(mapped.message, "Webhook event metadata is invalid");
    assert.deepEqual(mapped.details, []);
  });

  it("preserves a non-Error webhook parser failure", () => {
    assert.throws(
      () => mapHmacWebhookError("primitive parser failure"),
      (error: unknown) => error === "primitive parser failure",
    );
  });
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...BASE_CONFIG, ...overrides };
}

interface CoverageAppOptions {
  readonly eventStore: EventStore;
  readonly config?: AppConfig;
  readonly pool?: Pool;
  readonly database?: Database;
  readonly apiClientAuthenticator?: ApiClientAuthenticator;
  readonly connectionStore?: SourceConnectionStore;
  readonly notifier?: EventNotifier;
}

async function createCoverageApp(options: CoverageAppOptions): Promise<FastifyInstance> {
  const app = await buildApp({
    config: options.config ?? BASE_CONFIG,
    pool: options.pool ?? inertPool,
    database: options.database ?? databaseStub(),
    eventStore: options.eventStore,
    apiClientAuthenticator: options.apiClientAuthenticator ?? acceptingAuthenticator,
    connectionStore: options.connectionStore ?? noConnections,
    notifier: options.notifier ?? abortingNotifier,
  });
  openApps.add(app);
  return app;
}

async function trackApp(appPromise: Promise<FastifyInstance>): Promise<FastifyInstance> {
  const app = await appPromise;
  openApps.add(app);
  return app;
}

const acceptingAuthenticator: ApiClientAuthenticator = {
  async findActiveClientByKeyHash() {
    return TEST_CLIENT;
  },
  async verifyActiveClientByKeyHash() {
    return TEST_CLIENT;
  },
};

const abortingNotifier: EventNotifier = {
  async waitForTenant() {
    return "aborted";
  },
};

const noConnections: SourceConnectionStore = {
  async findActiveConnection() {
    return undefined;
  },
};

const inertPool = {
  async query() {
    return { rows: [{ ok: 1 }], rowCount: 1 };
  },
} as unknown as Pool;

function databaseStub(failure?: Error): Database {
  return {
    async execute() {
      if (failure !== undefined) {
        throw failure;
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Database;
}

function eventStoreStub(overrides: Partial<EventStore> = {}): EventStore {
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

function authorizationHeader(): Readonly<Record<string, string>> {
  return { authorization: "Bearer test-api-key" };
}

function requestWithId(value: string | string[] | undefined): IncomingMessage {
  return {
    headers: value === undefined ? {} : { "x-request-id": value },
  } as IncomingMessage;
}

function coverageError(kind: string): Error {
  switch (kind) {
    case "cloud-event":
      return new CloudEventValidationError(["bad event"]);
    case "cloud-event-empty":
      return new CloudEventValidationError([]);
    case "cursor":
      return new CursorValidationError("bad cursor");
    case "filter":
      return new EventFilterValidationError("bad filter");
    case "syntax":
      return new SyntaxError("bad JSON");
    case "fastify-large":
      return Object.assign(new Error("large"), { code: "FST_ERR_CTP_BODY_TOO_LARGE" });
    case "status-large":
      return Object.assign(new Error("large"), { statusCode: 413 });
    case "fastify-media":
      return Object.assign(new Error("media"), { code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" });
    case "status-media":
      return Object.assign(new Error("media"), { statusCode: 415 });
    case "pg-class":
      return Object.assign(new Error("class 08"), { code: "08006" });
    case "pg-shutdown":
      return Object.assign(new Error("shutdown"), { code: "57P01" });
    case "pg-crash":
      return Object.assign(new Error("crash"), { code: "57P02" });
    case "pg-cannot-connect":
      return Object.assign(new Error("cannot connect"), { code: "57P03" });
    case "pg-network":
      return Object.assign(new Error("network"), { code: "ECONNRESET" });
    case "pg-message":
      return new Error("connection terminated unexpectedly");
    case "pg-nested":
      return new Error("wrapper", {
        cause: Object.assign(new Error("nested"), { code: "EPIPE" }),
      });
    case "cycle": {
      const cyclic = new Error("cyclic") as Error & { cause?: unknown };
      cyclic.cause = cyclic;
      return cyclic;
    }
    case "primitive-cause":
      return new Error("wrapper", { cause: "not-an-error" });
    default:
      return new Error("unknown");
  }
}

function fakePoolClient(queries: string[], released: boolean[]): PoolClient {
  const listeners = new Map<string, Set<(...arguments_: unknown[]) => void>>();
  const client = {
    on(event: string, listener: (...arguments_: unknown[]) => void) {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(listener);
      listeners.set(event, handlers);
      return client;
    },
    off(event: string, listener: (...arguments_: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
      return client;
    },
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release(destroy?: boolean) {
      released.push(destroy ?? false);
    },
  };
  return client as unknown as PoolClient;
}

async function publish(
  app: FastifyInstance,
  event: Readonly<Record<string, unknown>>,
  idempotencyKey?: string,
) {
  return app.inject({
    method: "POST",
    url: "/v1/events",
    headers: {
      ...authorizationHeader(),
      "content-type": "application/cloudevents+json",
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    payload: JSON.stringify(event),
  });
}

async function requestSse(
  app: FastifyInstance,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ status: number; body: string }> {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${address}${path}`, { headers });
  return { status: response.status, body: await response.text() };
}

type WriteCall = (this: ServerResponse, ...arguments_: unknown[]) => boolean;
type WritePatch = (
  this: ServerResponse,
  original: WriteCall,
  arguments_: unknown[],
) => boolean;

function patchResponseWrite(patch: WritePatch): () => void {
  const original = ServerResponse.prototype.write as unknown as WriteCall;
  ServerResponse.prototype.write = function (this: ServerResponse, ...arguments_: unknown[]) {
    return patch.call(this, original, arguments_);
  } as typeof ServerResponse.prototype.write;
  return () => {
    ServerResponse.prototype.write = original as typeof ServerResponse.prototype.write;
  };
}

function connectionStore(signingSecret: string | undefined): SourceConnectionStore {
  return {
    async findActiveConnection() {
      return {
        id: "connection",
        tenantId: TEST_CLIENT.tenantId,
        provider: "hmac",
        stream: "webhooks",
        ...(signingSecret === undefined ? {} : { signingSecret }),
      };
    },
  };
}

async function signedWebhookApp(overrides: Partial<EventStore>): Promise<FastifyInstance> {
  return createCoverageApp({
    eventStore: eventStoreStub(overrides),
    connectionStore: connectionStore("webhook-secret-long-enough"),
  });
}

function webhookPayload(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id: "webhook-id",
    type: "com.example.webhook.v1",
    data: { ok: true },
    ...overrides,
  };
}

async function sendSignedWebhook(
  app: FastifyInstance,
  payload: Buffer | string | Readonly<Record<string, unknown>>,
) {
  const rawBody = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createWebhookSignature(
    "webhook-secret-long-enough",
    timestamp,
    "connection",
    rawBody,
  );
  return app.inject({
    method: "POST",
    url: "/v1/webhooks/hmac/connection",
    headers: {
      "content-type": "application/json",
      "x-eventhub-timestamp": timestamp,
      "x-eventhub-signature": signature,
    },
    payload: rawBody,
  });
}

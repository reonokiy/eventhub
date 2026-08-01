import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";

import { createWebhookSignature } from "../../src/security/webhook-signature.js";
import type { AppendEventCommand, EventStore } from "../../src/service/event-store.js";
import { createTestApp, storedEvent } from "../support/test-app.js";

describe("generic HMAC webhook API", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("authenticates the exact raw body and appends to the connection tenant and stream", async () => {
    let command: AppendEventCommand | undefined;
    const eventStore = eventStoreStub({
      async append(input) {
        command = input;
        return {
          status: "inserted",
          storedEvent: storedEvent(7n, {
            id: "delivery-7",
            source: "urn:eventhub:hmac:connection-7",
            type: "com.example.delivery.created.v1",
            eventhubstream: "webhooks",
            data: { delivery: 7 },
          }),
        };
      },
    });
    app = await createTestApp({
      eventStore,
      connectionStore: {
        async findActiveConnection() {
          return {
            id: "connection-7",
            tenantId: "webhook-tenant",
            provider: "hmac",
            stream: "webhooks",
            signingSecret: "webhook-secret",
          };
        },
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      id: "delivery-7",
      type: "com.example.delivery.created.v1",
      data: { delivery: 7 },
    });
    const signature = createWebhookSignature(
      "webhook-secret",
      timestamp,
      "connection-7",
      Buffer.from(rawBody, "utf8"),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/hmac/connection-7",
      headers: {
        "content-type": "application/json",
        "x-eventhub-timestamp": timestamp,
        "x-eventhub-signature": signature,
      },
      payload: rawBody,
    });

    assert.equal(response.statusCode, 202);
    assert.equal(command?.tenantId, "webhook-tenant");
    assert.equal(command?.event.eventhubstream, "webhooks");
    assert.equal(command?.event.source, "urn:eventhub:hmac:connection-7");
    assert.deepEqual(command?.event.data, { delivery: 7 });
    assert.equal(command?.idempotencyKey, undefined);
    assert.match(command?.requestHash ?? "", /^[0-9a-f]{64}$/);
  });

  it("rejects an invalid signature before appending an event", async () => {
    let appendCalls = 0;
    const eventStore = eventStoreStub({
      async append() {
        appendCalls += 1;
        return { status: "inserted", storedEvent: storedEvent(1n) };
      },
    });
    app = await createTestApp({
      eventStore,
      connectionStore: {
        async findActiveConnection() {
          return {
            id: "connection-7",
            tenantId: "webhook-tenant",
            provider: "hmac",
            stream: "webhooks",
            signingSecret: "webhook-secret",
          };
        },
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/hmac/connection-7",
      headers: {
        "content-type": "application/json",
        "x-eventhub-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-eventhub-signature": `v1=${"0".repeat(64)}`,
      },
      payload: '{"id":"delivery-7","type":"com.example.delivery.created.v1","data":{"delivery":7}}',
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, "invalid_signature");
    assert.equal(appendCalls, 0);
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

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { buildApp } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { appendEvent } from "../../src/db/events.js";
import { createDatabase } from "../../src/db/database.js";
import type { EventNotifier, WakeReason } from "../../src/realtime/notifier.js";
import { hashApiKey } from "../../src/security/api-key.js";
import { runMigrations } from "../../src/storage/migrations.js";

const testDatabaseUrl = process.env.EVENTHUB_TEST_DATABASE_URL?.trim() || undefined;

describe(
  "PostgreSQL-backed SSE recovery integration",
  {
    skip:
      testDatabaseUrl === undefined
        ? "set EVENTHUB_TEST_DATABASE_URL to run PostgreSQL integration tests"
        : false,
  },
  () => {
    let pool: Pool | undefined;

    before(async () => {
      assert.ok(testDatabaseUrl, "EVENTHUB_TEST_DATABASE_URL must be set for this suite");
      pool = new Pool({ connectionString: testDatabaseUrl, max: 12 });
      await runMigrations(pool);
    });

    after(async () => {
      await pool?.end();
    });

    it(
      "polls without NOTIFY and replays downtime events after rebuilding the app",
      { timeout: 15_000 },
      async () => {
        const database = requirePool(pool);
        const orm = createDatabase(database);
        await withHttpTestTenant(database, async ({ tenantId, apiKey }) => {
          const config = sseTestConfig(requireTestDatabaseUrl());
          const firstNotifier = new PollingOnlyNotifier();
          let firstApp: FastifyInstance | undefined;
          let secondApp: FastifyInstance | undefined;
          let firstStream: OpenSseStream | undefined;
          let secondStream: OpenSseStream | undefined;

          try {
            firstApp = await buildApp({
              config,
              pool: database,
              database: orm,
              notifier: firstNotifier,
            });
            const firstAddress = await firstApp.listen({ host: "127.0.0.1", port: 0 });
            firstStream = await openSse(firstAddress, apiKey, { after: "0" });

            await Promise.race([
              firstNotifier.firstPollCompleted,
              delay(3000, undefined, { ref: false }).then(() => {
                throw new Error("The polling-only notifier never completed its first poll");
              }),
            ]);

            const publishedOffset = await publishCloudEvent(
              firstAddress,
              apiKey,
              "live-event",
              { phase: "live" },
            );
            assert.equal(publishedOffset, "1");

            const liveEvent = await readBusinessEvent(firstStream);
            assert.equal(liveEvent.id, "1");
            assert.equal(liveEvent.event, "com.example.sse-recovery.v1");
            assert.equal(liveEvent.data.id, "live-event");
            assert.deepEqual(liveEvent.data.data, { phase: "live" });
            assert.ok(
              firstNotifier.completedPollCount >= 1,
              "the event must be discovered after a completed poll without NOTIFY",
            );

            await closeSse(firstStream);
            firstStream = undefined;
            await firstApp.close();
            firstApp = undefined;

            const downtimeAppend = await appendEvent(
              {
                tenantId,
                stream: "sse-recovery",
                id: "downtime-event",
                source: "urn:test:sse-recovery",
                type: "com.example.sse-recovery.v1",
                data: { phase: "downtime" },
              },
              orm,
            );
            assert.equal(downtimeAppend.event.offset, "2");

            const secondNotifier = new PollingOnlyNotifier();
            secondApp = await buildApp({
              config,
              pool: database,
              database: orm,
              notifier: secondNotifier,
            });
            const secondAddress = await secondApp.listen({ host: "127.0.0.1", port: 0 });
            secondStream = await openSse(secondAddress, apiKey, {
              after: "0",
              lastEventId: liveEvent.id,
            });

            const replayedEvent = await readBusinessEvent(secondStream);
            assert.equal(replayedEvent.id, "2");
            assert.equal(replayedEvent.event, "com.example.sse-recovery.v1");
            assert.equal(replayedEvent.data.id, "downtime-event");
            assert.deepEqual(replayedEvent.data.data, { phase: "downtime" });
            assert.ok(
              secondNotifier.pollCount >= 1,
              "the rebuilt app must use the injected polling-only notifier",
            );
          } finally {
            if (firstStream !== undefined) {
              await closeSse(firstStream);
            }
            if (secondStream !== undefined) {
              await closeSse(secondStream);
            }
            await firstApp?.close();
            await secondApp?.close();
          }
        });
      },
    );
  },
);

class PollingOnlyNotifier implements EventNotifier {
  public pollCount = 0;
  public completedPollCount = 0;
  public readonly firstPollCompleted: Promise<void>;
  readonly #resolveFirstPoll: () => void;

  public constructor() {
    let resolveFirstPoll: (() => void) | undefined;
    this.firstPollCompleted = new Promise<void>((resolve) => {
      resolveFirstPoll = resolve;
    });
    assert.ok(resolveFirstPoll);
    this.#resolveFirstPoll = resolveFirstPoll;
  }

  public async waitForTenant(
    _tenantId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WakeReason> {
    this.pollCount += 1;
    if (isAborted(signal)) {
      return "aborted";
    }
    try {
      await delay(timeoutMs, undefined, { signal, ref: false });
      this.completedPollCount += 1;
      this.#resolveFirstPoll();
      return "poll";
    } catch (error) {
      if (isAborted(signal)) {
        return "aborted";
      }
      throw error;
    }
  }
}

interface OpenSseStream {
  readonly controller: AbortController;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: string;
}

interface SseBusinessEvent {
  readonly id: string;
  readonly event: string;
  readonly data: {
    readonly id: string;
    readonly data: unknown;
  };
}

async function openSse(
  address: string,
  apiKey: string,
  cursor: { readonly after: string; readonly lastEventId?: string },
): Promise<OpenSseStream> {
  const controller = new AbortController();
  const response = await fetch(`${address}/v1/events/stream?after=${cursor.after}`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "text/event-stream",
      ...(cursor.lastEventId === undefined ? {} : { "last-event-id": cursor.lastEventId }),
    },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.ok(response.body, "SSE response must have a readable body");
  return { controller, reader: response.body.getReader(), buffer: "" };
}

async function readBusinessEvent(stream: OpenSseStream): Promise<SseBusinessEvent> {
  const decoder = new TextDecoder();
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Timed out waiting for an SSE business event")), 5000);
    timeout.unref();
  });

  try {
    while (true) {
      const boundary = stream.buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = stream.buffer.slice(0, boundary);
        stream.buffer = stream.buffer.slice(boundary + 2);
        const parsed = parseSseFrame(frame);
        if (parsed !== undefined) {
          return parsed;
        }
        continue;
      }

      const chunk = await Promise.race([stream.reader.read(), deadline]);
      if (chunk.done) {
        throw new Error("SSE connection ended before a business event arrived");
      }
      stream.buffer += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function parseSseFrame(frame: string): SseBusinessEvent | undefined {
  let id: string | undefined;
  let event: string | undefined;
  let data: string | undefined;
  for (const line of frame.split("\n")) {
    if (line.startsWith("id: ")) {
      id = line.slice(4);
    } else if (line.startsWith("event: ")) {
      event = line.slice(7);
    } else if (line.startsWith("data: ")) {
      data = line.slice(6);
    }
  }
  if (id === undefined || event === undefined || data === undefined) {
    return undefined;
  }
  const parsed = JSON.parse(data) as { id?: unknown; data?: unknown };
  if (typeof parsed.id !== "string") {
    throw new TypeError("SSE event data must contain a string id");
  }
  return {
    id,
    event,
    data: { id: parsed.id, data: parsed.data },
  };
}

async function closeSse(stream: OpenSseStream): Promise<void> {
  stream.controller.abort();
  await stream.reader.cancel().catch(() => undefined);
}

async function publishCloudEvent(
  address: string,
  apiKey: string,
  id: string,
  data: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`${address}/v1/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/cloudevents+json",
    },
    body: JSON.stringify({
      specversion: "1.0",
      id,
      source: "urn:test:sse-recovery",
      type: "com.example.sse-recovery.v1",
      datacontenttype: "application/json",
      eventhubstream: "sse-recovery",
      data,
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 201, responseText);
  const body = JSON.parse(responseText) as { eventhuboffset?: unknown };
  if (typeof body.eventhuboffset !== "string") {
    throw new TypeError("Published event must contain a string eventhuboffset");
  }
  return body.eventhuboffset;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sseTestConfig(databaseUrl: string): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.EVENTHUB_TEST_LOG_LEVEL ?? "silent",
    DATABASE_URL: databaseUrl,
    SSE_POLL_INTERVAL_MS: "250",
    SSE_HEARTBEAT_INTERVAL_MS: "1000",
    SSE_WRITE_TIMEOUT_MS: "2000",
  });
}

async function withHttpTestTenant(
  database: Pool,
  run: (fixture: { tenantId: string; apiKey: string }) => Promise<void>,
): Promise<void> {
  const tenantId = randomUUID();
  const apiClientId = randomUUID();
  const apiKey = `sse-test-${randomUUID()}`;
  await database.query(
    "INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'SSE integration test tenant')",
    [tenantId, `sse-test-${tenantId}`],
  );
  await database.query(
    `INSERT INTO api_clients (id, tenant_id, name, key_prefix, key_hash)
     VALUES ($1, $2, 'SSE integration test client', $3, $4)`,
    [apiClientId, tenantId, apiKey.slice(0, 12), hashApiKey(apiKey)],
  );
  try {
    await run({ tenantId, apiKey });
  } finally {
    await database.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  }
}

function requirePool(pool: Pool | undefined): Pool {
  assert.ok(pool, "PostgreSQL pool must be initialized by the suite hook");
  return pool;
}

function requireTestDatabaseUrl(): string {
  assert.ok(testDatabaseUrl, "EVENTHUB_TEST_DATABASE_URL must be set for this suite");
  return testDatabaseUrl;
}

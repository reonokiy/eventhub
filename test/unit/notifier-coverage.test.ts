import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import type { Notification, Pool, PoolClient } from "pg";

import {
  PostgresNotifier,
  type NotifierLogger,
} from "../../src/realtime/notifier.js";

describe("PostgresNotifier infrastructure coverage", () => {
  it("handles every wake reason and notification payload shape", async () => {
    const client = new FakePoolClient();
    const pool = new FakePool(client);
    const logger = new RecordingNotifierLogger();
    const notifier = new PostgresNotifier(pool.asPool(), logger);

    const startupWake = notifier.waitForTenant("startup", 100);
    await notifier.start();
    assert.equal(await startupWake, "notification");

    await notifier.start();
    assert.equal(pool.connectCalls, 1);

    await assertNotificationWake(client, notifier, "tenant-a", '{"tenant_id":"tenant-a"}');

    for (const payload of [undefined, "", "not-json", "1", "null", "{}", '{"tenant_id":42}']) {
      await assertNotificationWake(client, notifier, "tenant-a", payload);
    }

    const wrongChannelWake = notifier.waitForTenant("tenant-a", 1);
    client.notify('{"tenant_id":"tenant-a"}', "some_other_channel");
    assert.equal(await wrongChannelWake, "poll");

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    assert.equal(await notifier.waitForTenant("tenant-a", 100, alreadyAborted.signal), "aborted");

    const abortController = new AbortController();
    const abortWake = notifier.waitForTenant("tenant-a", 100, abortController.signal);
    abortController.abort();
    assert.equal(await abortWake, "aborted");

    await notifier.stop();
    assert.deepEqual(client.releaseArguments, [false]);
    await notifier.stop();
  });

  it("shares an in-flight connection between concurrent starts", async () => {
    const client = new FakePoolClient();
    const connection = deferred<FakePoolClient>();
    const pool = new FakePool(connection.promise);
    const notifier = new PostgresNotifier(pool.asPool(), new RecordingNotifierLogger(), 0);

    const firstStart = notifier.start();
    const secondStart = notifier.start();
    connection.resolve(client);

    await Promise.all([firstStart, secondStart]);
    assert.equal(pool.connectCalls, 1);
    await notifier.stop();
  });

  it("resets after connect and LISTEN failures", async () => {
    const connectFailure = new Error("connect failed");
    const listenFailure = new Error("LISTEN failed");
    const failedListenClient = new FakePoolClient();
    failedListenClient.listenError = listenFailure;
    const recoveredClient = new FakePoolClient();
    const pool = new FakePool(connectFailure, failedListenClient, recoveredClient);
    const notifier = new PostgresNotifier(pool.asPool(), new RecordingNotifierLogger(), 0);

    await assert.rejects(notifier.start(), connectFailure);
    await assert.rejects(notifier.start(), listenFailure);
    assert.deepEqual(failedListenClient.releaseArguments, [true]);

    await notifier.start();
    assert.equal(pool.connectCalls, 3);
    await notifier.stop();
  });

  it("waits for and absorbs an in-flight connection rejection while stopping", async () => {
    const connection = deferred<FakePoolClient>();
    const pool = new FakePool(connection.promise);
    const notifier = new PostgresNotifier(pool.asPool(), new RecordingNotifierLogger(), 0);
    const failure = new Error("late connect failure");

    const start = notifier.start();
    const startRejected = assert.rejects(start, failure);
    const stop = notifier.stop();
    connection.reject(failure);

    await Promise.all([startRejected, stop]);
  });

  it("destroys a client when stop wins the LISTEN race", async () => {
    const listenGate = deferred<void>();
    const client = new FakePoolClient();
    client.listenGate = listenGate.promise;
    const notifier = new PostgresNotifier(
      new FakePool(client).asPool(),
      new RecordingNotifierLogger(),
      0,
    );

    const start = notifier.start();
    await waitUntil(() => client.queries.includes("LISTEN eventhub_events"));
    const stop = notifier.stop();
    listenGate.resolve();

    await Promise.all([start, stop]);
    assert.deepEqual(client.releaseArguments, [true]);
  });

  it("destroys a client and warns when UNLISTEN fails", async () => {
    const client = new FakePoolClient();
    client.unlistenError = new Error("UNLISTEN failed");
    const logger = new RecordingNotifierLogger();
    const notifier = new PostgresNotifier(new FakePool(client).asPool(), logger, 0);

    await notifier.start();
    await notifier.stop();

    assert.deepEqual(client.releaseArguments, [true]);
    assert.equal(logger.warnings.length, 1);
  });

  it("clears a connection if setup logging throws and can subsequently restart", async () => {
    const firstClient = new FakePoolClient();
    const secondClient = new FakePoolClient();
    const logger = new RecordingNotifierLogger();
    const loggingFailure = new Error("logger failed");
    logger.infoError = loggingFailure;
    const pool = new FakePool(firstClient, secondClient);
    const notifier = new PostgresNotifier(pool.asPool(), logger, 0);

    await assert.rejects(notifier.start(), loggingFailure);
    assert.deepEqual(firstClient.releaseArguments, [true]);

    logger.infoError = undefined;
    await notifier.start();
    assert.equal(pool.connectCalls, 2);
    await notifier.stop();
  });

  it("handles error/end events, stale callbacks, and an already scheduled reconnect", async () => {
    const firstClient = new FakePoolClient();
    const secondClient = new FakePoolClient();
    const thirdClient = new FakePoolClient();
    const pool = new FakePool(firstClient, secondClient, thirdClient);
    const logger = new RecordingNotifierLogger();
    const notifier = new PostgresNotifier(pool.asPool(), logger, 20);

    await notifier.start();
    const staleErrorHandler = firstClient.listeners("error")[0] as (error: Error) => void;
    const connectionFailure = new Error("listener failed");
    firstClient.emit("error", connectionFailure);
    assert.deepEqual(firstClient.releaseArguments, [true]);
    assert.equal(logger.errors.length, 1);

    await notifier.start();
    assert.equal(pool.connectCalls, 2);
    secondClient.emit("end");
    staleErrorHandler(new Error("late stale error"));

    await waitUntil(() => pool.connectCalls === 3);
    await waitUntil(() => logger.infos.length === 3);
    assert.deepEqual(secondClient.releaseArguments, [true]);
    assert.equal(logger.errors.length, 1, "an end event has no Error to log");
    await notifier.stop();
  });

  it("retries after a failed reconnect and eventually recovers", async () => {
    const firstClient = new FakePoolClient();
    const recoveredClient = new FakePoolClient();
    const reconnectFailure = new Error("reconnect failed");
    const pool = new FakePool(firstClient, reconnectFailure, recoveredClient);
    const logger = new RecordingNotifierLogger();
    const notifier = new PostgresNotifier(pool.asPool(), logger, 0);

    await notifier.start();
    firstClient.emit("error", new Error("connection lost"));

    await waitUntil(() => pool.connectCalls === 3);
    await waitUntil(() => logger.infos.length === 2);
    assert.equal(logger.warnings.length, 1);
    await notifier.stop();
  });

  it("does not reschedule a reconnect that fails after stop", async () => {
    const firstClient = new FakePoolClient();
    const reconnect = deferred<FakePoolClient>();
    const pool = new FakePool(firstClient, reconnect.promise);
    const logger = new RecordingNotifierLogger();
    const notifier = new PostgresNotifier(pool.asPool(), logger, 0);

    await notifier.start();
    firstClient.emit("end");
    await waitUntil(() => pool.connectCalls === 2);

    const stop = notifier.stop();
    reconnect.reject(new Error("reconnect rejected after stop"));
    await stop;

    await flushTasks();
    assert.equal(pool.connectCalls, 2);
    assert.equal(logger.warnings.length, 1);
  });

  it("cancels a pending reconnect during stop", async () => {
    const firstClient = new FakePoolClient();
    const pool = new FakePool(firstClient);
    const notifier = new PostgresNotifier(
      pool.asPool(),
      new RecordingNotifierLogger(),
      60_000,
    );

    await notifier.start();
    firstClient.emit("end");
    await notifier.stop();
    await flushTasks();

    assert.equal(pool.connectCalls, 1);
  });
});

class FakePoolClient extends EventEmitter {
  public readonly queries: string[] = [];
  public readonly releaseArguments: Array<Error | boolean | undefined> = [];
  public listenGate: Promise<void> | undefined;
  public listenError: Error | undefined;
  public unlistenError: Error | undefined;

  public async query(query: string): Promise<object> {
    this.queries.push(query);
    if (query === "LISTEN eventhub_events") {
      await this.listenGate;
      if (this.listenError !== undefined) {
        throw this.listenError;
      }
    }
    if (query === "UNLISTEN eventhub_events" && this.unlistenError !== undefined) {
      throw this.unlistenError;
    }
    return {};
  }

  public release(error?: Error | boolean): void {
    this.releaseArguments.push(error);
  }

  public notify(payload: string | undefined, channel = "eventhub_events"): void {
    const value: Notification =
      payload === undefined
        ? { processId: 1, channel }
        : { processId: 1, channel, payload };
    this.emit("notification", value);
  }

  public asPoolClient(): PoolClient {
    return this as unknown as PoolClient;
  }
}

type ConnectStep = FakePoolClient | Promise<FakePoolClient> | Error;

class FakePool {
  readonly #steps: ConnectStep[];
  public connectCalls = 0;

  public constructor(...steps: ConnectStep[]) {
    this.#steps = [...steps];
  }

  public async connect(): Promise<PoolClient> {
    this.connectCalls += 1;
    const step = this.#steps.shift();
    assert.ok(step, `missing fake client for connect call ${this.connectCalls}`);
    if (step instanceof Error) {
      throw step;
    }
    return (await step).asPoolClient();
  }

  public asPool(): Pool {
    return this as unknown as Pool;
  }
}

class RecordingNotifierLogger implements NotifierLogger {
  public readonly infos: Array<{ properties: object; message: string }> = [];
  public readonly warnings: Array<{ properties: object; message: string }> = [];
  public readonly errors: Array<{ properties: object; message: string }> = [];
  public infoError: Error | undefined;

  public info(properties: object, message: string): void {
    if (this.infoError !== undefined) {
      throw this.infoError;
    }
    this.infos.push({ properties, message });
  }

  public warn(properties: object, message: string): void {
    this.warnings.push({ properties, message });
  }

  public error(properties: object, message: string): void {
    this.errors.push({ properties, message });
  }
}

async function assertNotificationWake(
  client: FakePoolClient,
  notifier: PostgresNotifier,
  tenantId: string,
  payload: string | undefined,
): Promise<void> {
  const wake = notifier.waitForTenant(tenantId, 100);
  client.notify(payload);
  assert.equal(await wake, "notification");
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition was not met before the test deadline");
}

function flushTasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

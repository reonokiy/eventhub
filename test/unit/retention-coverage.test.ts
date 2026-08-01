import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Database } from "../../src/db/database.js";
import {
  RetentionWorker,
  type RetentionLogger,
} from "../../src/retention/worker.js";

describe("RetentionWorker infrastructure coverage", () => {
  it("runs an empty pass, ignores a duplicate start, and can stop before starting", async () => {
    const database = new FakeRetentionDatabase(0);
    const logger = new RecordingRetentionLogger();
    const worker = new RetentionWorker(database.asDatabase(), logger);

    await worker.stop();
    worker.start();
    worker.start();
    await worker.stop();

    assert.equal(database.executeCalls, 1);
    assert.equal(database.idempotencyDeleteCalls, 1);
    assert.deepEqual(logger.infos, []);
  });

  it("logs deletions, leaves a timer scheduled, and ignores start while timed", async () => {
    const database = new FakeRetentionDatabase(5);
    const logger = new RecordingRetentionLogger();
    const worker = new RetentionWorker(database.asDatabase(), logger, 60_000);

    worker.start();
    await waitUntil(() => database.idempotencyDeleteCalls === 1);
    await flushTasks();
    worker.start();
    await worker.stop();

    assert.deepEqual(logger.infos, [
      {
        properties: { deletedEvents: 5 },
        message: "Deleted events outside tenant retention windows",
      },
    ]);
  });

  it("executes the timer callback and waits for an active pass during stop", async () => {
    const secondPass = deferred<number>();
    const database = new FakeRetentionDatabase(0, secondPass.promise);
    const worker = new RetentionWorker(
      database.asDatabase(),
      new RecordingRetentionLogger(),
      0,
    );

    worker.start();
    await waitUntil(() => database.executeCalls === 2);
    const stop = worker.stop();
    secondPass.resolve(0);
    await stop;

    assert.equal(database.idempotencyDeleteCalls, 2);
  });

  it("continues full batches until a short batch", async () => {
    const database = new FakeRetentionDatabase(1000, 999);
    const logger = new RecordingRetentionLogger();
    const worker = new RetentionWorker(database.asDatabase(), logger, 60_000);

    worker.start();
    await worker.stop();

    assert.equal(database.executeCalls, 2);
    assert.equal(database.idempotencyDeleteCalls, 1);
    assert.deepEqual(logger.infos[0]?.properties, { deletedEvents: 1999 });
  });

  it("caps one cleanup pass at one hundred full batches", async () => {
    const database = new FakeRetentionDatabase(...Array<number>(100).fill(1000));
    const logger = new RecordingRetentionLogger();
    const worker = new RetentionWorker(database.asDatabase(), logger, 60_000);

    worker.start();
    await worker.stop();

    assert.equal(database.executeCalls, 100);
    assert.equal(database.idempotencyDeleteCalls, 1);
    assert.deepEqual(logger.infos[0]?.properties, { deletedEvents: 100_000 });
  });

  it("logs an event deletion query failure and keeps scheduling", async () => {
    const failure = new Error("event cleanup failed");
    const database = new FakeRetentionDatabase(failure);
    const logger = new RecordingRetentionLogger();
    const worker = new RetentionWorker(database.asDatabase(), logger, 60_000);

    worker.start();
    await waitUntil(() => logger.errors.length === 1);
    await flushTasks();
    await worker.stop();

    assert.equal(logger.errors[0]?.properties.err, failure);
  });

  it("logs an idempotency cleanup failure", async () => {
    const failure = new Error("idempotency cleanup failed");
    const database = new FakeRetentionDatabase(0);
    database.idempotencyDeleteError = failure;
    const logger = new RecordingRetentionLogger();
    const worker = new RetentionWorker(database.asDatabase(), logger, 60_000);

    worker.start();
    await waitUntil(() => logger.errors.length === 1);
    await worker.stop();

    assert.equal(logger.errors[0]?.properties.err, failure);
  });
});

type DeleteCountStep = number | Error | Promise<number>;

class FakeRetentionDatabase {
  readonly #steps: DeleteCountStep[];
  public executeCalls = 0;
  public idempotencyDeleteCalls = 0;
  public idempotencyDeleteError: Error | undefined;

  public constructor(...steps: DeleteCountStep[]) {
    this.#steps = [...steps];
  }

  public async execute(): Promise<{ rows: Array<{ deletedCount: string }> }> {
    this.executeCalls += 1;
    const step = this.#steps.shift();
    assert.notEqual(step, undefined, `missing deletion count for batch ${this.executeCalls}`);
    if (step instanceof Error) {
      throw step;
    }
    const deletedCount = await step;
    return { rows: [{ deletedCount: String(deletedCount) }] };
  }

  public delete(): { where: () => Promise<void> } {
    return {
      where: async () => {
        this.idempotencyDeleteCalls += 1;
        if (this.idempotencyDeleteError !== undefined) {
          throw this.idempotencyDeleteError;
        }
      },
    };
  }

  public asDatabase(): Database {
    return this as unknown as Database;
  }
}

class RecordingRetentionLogger implements RetentionLogger {
  public readonly infos: Array<{ properties: object; message: string }> = [];
  public readonly errors: Array<{ properties: { err: unknown }; message: string }> = [];

  public info(properties: object, message: string): void {
    this.infos.push({ properties, message });
  }

  public error(properties: object, message: string): void {
    this.errors.push({ properties: properties as { err: unknown }, message });
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

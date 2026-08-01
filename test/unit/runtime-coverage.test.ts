import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolConfig } from "pg";

import type { BuildAppOptions } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import type { Database } from "../../src/db/database.js";
import type { BootstrapOptions, BootstrapResult } from "../../src/db/types.js";
import {
  startEventHubRuntime,
  type RuntimeDependencies,
  type RuntimeRetentionWorker,
} from "../../src/runtime.js";

describe("EventHub runtime lifecycle", () => {
  it("starts every service, reports idle pool errors, and shuts down once", async () => {
    const harness = new RuntimeHarness();
    const config = createConfig({
      migrateOnStart: true,
      usesInsecureDevelopmentSecrets: true,
    });

    const runtime = await startEventHubRuntime(config, harness.dependencies());

    assert.deepEqual(harness.poolConfig, {
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
      query_timeout: config.databaseQueryTimeoutMs,
    });
    assert.equal(harness.migrationCalls, 1);
    assert.deepEqual(harness.bootstrapOptions, {
      tenantId: config.bootstrapTenantId,
      tenantName: config.bootstrapTenantName,
      apiKey: config.bootstrapApiKey,
      retentionDays: config.eventRetentionDays,
      webhook: {
        id: config.bootstrapWebhookConnectionId,
        secret: config.bootstrapWebhookSecret,
        provider: "hmac",
        name: "bootstrap-hmac",
        stream: "default",
      },
    });
    assert.equal(harness.bootstrapDatabase, harness.database);
    assert.equal(harness.buildOptions?.config, config);
    assert.equal(harness.buildOptions?.pool, harness.pool.asPool());
    assert.equal(harness.buildOptions?.database, harness.database);
    assert.equal(harness.worker.startCalls, 1);
    assert.deepEqual(harness.app.listenOptions, [{ host: "127.0.0.1", port: 4312 }]);
    assert.deepEqual(harness.app.warnings, [
      "EventHub is using development admin/API/webhook secrets; replace them before exposing the service",
    ]);
    assert.deepEqual([...harness.signalListeners.keys()], ["SIGINT", "SIGTERM"]);

    const idleError = new Error("idle client failed");
    harness.pool.emitError(idleError);
    assert.deepEqual(harness.reportedErrors, [
      ["Idle PostgreSQL client failed", idleError],
    ]);

    await harness.signal("SIGINT");
    await harness.signal("SIGTERM");
    await runtime.shutdown("manual");

    assert.equal(harness.worker.stopCalls, 1);
    assert.equal(harness.app.closeCalls, 1);
    assert.equal(harness.closePoolCalls, 1);
    assert.deepEqual(harness.exitCodes, []);
    assert.deepEqual(harness.app.infos, [
      {
        properties: {
          tenantId: "00000000-0000-4000-8000-000000000001",
          apiClientId: "00000000-0000-4000-8000-000000000003",
          sourceConnectionId: "00000000-0000-4000-8000-000000000002",
        },
        message: "Bootstrap tenant and credentials are ready",
      },
      {
        properties: { signal: "SIGINT" },
        message: "Shutting down EventHub",
      },
    ]);
  });

  it("skips migrations and warnings and reports graceful-shutdown failures", async () => {
    const harness = new RuntimeHarness();
    const stopError = new Error("retention stop failed");
    harness.worker.stopError = stopError;

    await startEventHubRuntime(
      createConfig({ migrateOnStart: false, usesInsecureDevelopmentSecrets: false }),
      harness.dependencies(),
    );
    await harness.signal("SIGTERM");

    assert.equal(harness.migrationCalls, 0);
    assert.deepEqual(harness.app.warnings, []);
    assert.equal(harness.worker.stopCalls, 1);
    assert.equal(harness.app.closeCalls, 1);
    assert.equal(harness.closePoolCalls, 1);
    assert.deepEqual(harness.reportedErrors, [[stopError]]);
    assert.deepEqual(harness.exitCodes, [1]);
  });

  it("makes concurrent shutdown callers wait for the same cleanup", async () => {
    const harness = new RuntimeHarness();
    const stopGate = deferred<void>();
    harness.worker.stopGate = stopGate.promise;
    const runtime = await startEventHubRuntime(createConfig(), harness.dependencies());

    const firstShutdown = runtime.shutdown("first");
    const concurrentShutdown = runtime.shutdown("second");
    let concurrentSettled = false;
    void concurrentShutdown.then(() => {
      concurrentSettled = true;
    });

    await Promise.resolve();
    assert.equal(firstShutdown, concurrentShutdown);
    assert.equal(concurrentSettled, false);
    stopGate.resolve();
    await Promise.all([firstShutdown, concurrentShutdown]);

    assert.equal(harness.worker.stopCalls, 1);
    assert.equal(harness.app.closeCalls, 1);
    assert.equal(harness.closePoolCalls, 1);
    assert.deepEqual(harness.app.infos.at(-1), {
      properties: { signal: "first" },
      message: "Shutting down EventHub",
    });
  });

  it("closes the pool when database initialization fails and remains safely stoppable", async () => {
    const harness = new RuntimeHarness();
    const databaseError = new Error("database initialization failed");
    harness.createDatabaseError = databaseError;

    const runtime = await startEventHubRuntime(createConfig(), harness.dependencies());

    assert.equal(harness.migrationCalls, 0);
    assert.equal(harness.bootstrapOptions, undefined);
    assert.equal(harness.closePoolCalls, 1);
    assert.deepEqual(harness.reportedErrors, [[databaseError]]);
    assert.deepEqual(harness.exitCodes, [1]);

    await runtime.shutdown("manual");
    await runtime.shutdown("manual-again");
    assert.equal(harness.closePoolCalls, 1);
  });

  it("cleans up all started components when listening fails", async () => {
    const harness = new RuntimeHarness();
    const listenError = new Error("listen failed");
    harness.app.listenError = listenError;

    await startEventHubRuntime(createConfig(), harness.dependencies());

    assert.equal(harness.worker.stopCalls, 1);
    assert.equal(harness.app.closeCalls, 1);
    assert.equal(harness.closePoolCalls, 1);
    assert.deepEqual(harness.reportedErrors, [[listenError]]);
    assert.deepEqual(harness.exitCodes, [1]);
  });

  it("continues startup cleanup when every release operation rejects", async () => {
    const harness = new RuntimeHarness();
    const listenError = new Error("listen failed");
    harness.app.listenError = listenError;
    harness.worker.stopError = new Error("stop failed");
    harness.app.closeError = new Error("close failed");
    harness.closePoolError = new Error("pool close failed");

    await startEventHubRuntime(createConfig(), harness.dependencies());

    assert.equal(harness.worker.stopCalls, 1);
    assert.equal(harness.app.closeCalls, 1);
    assert.equal(harness.closePoolCalls, 1);
    assert.deepEqual(harness.reportedErrors, [[listenError]]);
    assert.deepEqual(harness.exitCodes, [1]);
  });
});

class RuntimeHarness {
  public readonly pool = new FakePool();
  public readonly database = {} as Database;
  public readonly app = new FakeApp();
  public readonly worker = new FakeWorker();
  public readonly signalListeners = new Map<NodeJS.Signals, () => Promise<void>>();
  public readonly reportedErrors: unknown[][] = [];
  public readonly exitCodes: number[] = [];
  public poolConfig: PoolConfig | undefined;
  public bootstrapOptions: BootstrapOptions | undefined;
  public bootstrapDatabase: Database | undefined;
  public buildOptions: BuildAppOptions | undefined;
  public migrationCalls = 0;
  public closePoolCalls = 0;
  public createDatabaseError: Error | undefined;
  public closePoolError: Error | undefined;

  public dependencies(): RuntimeDependencies {
    return {
      createPool: (config) => {
        this.poolConfig = config;
        return this.pool.asPool();
      },
      closePool: async (pool) => {
        assert.equal(pool, this.pool.asPool());
        this.closePoolCalls += 1;
        if (this.closePoolError !== undefined) {
          throw this.closePoolError;
        }
      },
      createDatabase: (pool) => {
        assert.equal(pool, this.pool.asPool());
        if (this.createDatabaseError !== undefined) {
          throw this.createDatabaseError;
        }
        return this.database;
      },
      runMigrations: async (pool) => {
        assert.equal(pool, this.pool.asPool());
        this.migrationCalls += 1;
      },
      ensureBootstrapTenantAndClient: async (options, database) => {
        this.bootstrapOptions = options;
        this.bootstrapDatabase = database;
        return BOOTSTRAP_RESULT;
      },
      buildApp: async (options) => {
        this.buildOptions = options;
        return this.app.asFastifyInstance();
      },
      createRetentionWorker: (database, logger) => {
        assert.equal(database, this.database);
        assert.equal(logger, this.app.logger);
        return this.worker;
      },
      registerSignal: (signal, listener) => {
        this.signalListeners.set(signal, listener);
      },
      reportError: (...values) => {
        this.reportedErrors.push([...values]);
      },
      setExitCode: (code) => {
        this.exitCodes.push(code);
      },
    };
  }

  public async signal(signal: NodeJS.Signals): Promise<void> {
    const listener = this.signalListeners.get(signal);
    if (listener === undefined) {
      throw new Error(`No listener registered for ${signal}`);
    }
    await listener();
  }
}

class FakePool {
  readonly #errorListeners: Array<(error: Error) => void> = [];

  public on(event: string, listener: (error: Error) => void): this {
    assert.equal(event, "error");
    this.#errorListeners.push(listener);
    return this;
  }

  public emitError(error: Error): void {
    for (const listener of this.#errorListeners) {
      listener(error);
    }
  }

  public asPool(): Pool {
    return this as unknown as Pool;
  }
}

interface LogRecord {
  readonly properties: object;
  readonly message: string;
}

class FakeApp {
  public readonly warnings: string[] = [];
  public readonly infos: LogRecord[] = [];
  public readonly listenOptions: Array<{ host: string; port: number }> = [];
  public readonly logger = {
    warn: (message: string): void => {
      this.warnings.push(message);
    },
    info: (properties: object, message: string): void => {
      this.infos.push({ properties, message });
    },
  };
  public listenError: Error | undefined;
  public closeError: Error | undefined;
  public closeCalls = 0;

  public async listen(options: { host: string; port: number }): Promise<string> {
    this.listenOptions.push(options);
    if (this.listenError !== undefined) {
      throw this.listenError;
    }
    return `http://${options.host}:${options.port}`;
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  }

  public asFastifyInstance(): FastifyInstance {
    return {
      close: this.close.bind(this),
      listen: this.listen.bind(this),
      log: this.logger,
    } as unknown as FastifyInstance;
  }
}

class FakeWorker implements RuntimeRetentionWorker {
  public startCalls = 0;
  public stopCalls = 0;
  public stopError: Error | undefined;
  public stopGate: Promise<void> | undefined;

  public start(): void {
    this.startCalls += 1;
  }

  public async stop(): Promise<void> {
    this.stopCalls += 1;
    await this.stopGate;
    if (this.stopError !== undefined) {
      throw this.stopError;
    }
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise!: (value: Value) => void;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

const BOOTSTRAP_RESULT: BootstrapResult = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  apiClient: {
    id: "00000000-0000-4000-8000-000000000003",
    tenantId: "00000000-0000-4000-8000-000000000001",
    name: "bootstrap",
    keyPrefix: "production-a",
    scopes: ["events:read", "events:write"],
    expiresAt: null,
  },
  sourceConnectionId: "00000000-0000-4000-8000-000000000002",
};

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 4312,
    logLevel: "silent",
    databaseUrl: "postgres://eventhub:eventhub@localhost:5433/eventhub",
    databasePoolMax: 7,
    databaseConnectionTimeoutMs: 1234,
    databaseQueryTimeoutMs: 5678,
    migrateOnStart: false,
    bootstrapTenantId: "00000000-0000-4000-8000-000000000001",
    bootstrapTenantName: "Runtime test tenant",
    bootstrapApiKey: "production-api-key",
    adminApiKey: "production-admin-api-key",
    bootstrapWebhookConnectionId: "00000000-0000-4000-8000-000000000002",
    bootstrapWebhookSecret: "production-webhook-secret",
    eventRetentionDays: 45,
    maxEventBytes: 65_536,
    sseBatchSize: 100,
    ssePollIntervalMs: 1000,
    sseHeartbeatIntervalMs: 5000,
    sseWriteTimeoutMs: 10_000,
    webhookMaxClockSkewSeconds: 120,
    usesInsecureDevelopmentSecrets: false,
    ...overrides,
  };
}

import type { FastifyInstance } from "fastify";
import type { Pool, PoolConfig } from "pg";

import type { BuildAppOptions } from "./app.js";
import type { AppConfig } from "./config.js";
import type { Database } from "./db/database.js";
import type { BootstrapOptions, BootstrapResult } from "./db/types.js";
import type { RetentionLogger } from "./retention/worker.js";

export interface RuntimeRetentionWorker {
  start(): void;
  stop(): Promise<void>;
}

export interface RuntimeDependencies {
  readonly createPool: (config: PoolConfig) => Pool;
  readonly closePool: (pool: Pool) => Promise<void>;
  readonly createDatabase: (pool: Pool) => Database;
  readonly runMigrations: (pool: Pool) => Promise<void>;
  readonly ensureBootstrapTenantAndClient: (
    options: BootstrapOptions,
    database: Database,
  ) => Promise<BootstrapResult>;
  readonly buildApp: (options: BuildAppOptions) => Promise<FastifyInstance>;
  readonly createRetentionWorker: (
    database: Database,
    logger: RetentionLogger,
  ) => RuntimeRetentionWorker;
  readonly registerSignal: (
    signal: NodeJS.Signals,
    listener: () => Promise<void>,
  ) => void;
  readonly reportError: (...values: readonly unknown[]) => void;
  readonly setExitCode: (code: number) => void;
}

export interface EventHubRuntime {
  shutdown(signal: string): Promise<void>;
}

export async function startEventHubRuntime(
  config: AppConfig,
  dependencies: RuntimeDependencies,
): Promise<EventHubRuntime> {
  const pool = dependencies.createPool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    query_timeout: config.databaseQueryTimeoutMs,
  });
  pool.on("error", (error) => {
    dependencies.reportError("Idle PostgreSQL client failed", error);
  });

  let app: FastifyInstance | undefined;
  let retentionWorker: RuntimeRetentionWorker | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const releaseResources = async (ignoreFailures: boolean): Promise<void> => {
    const failures: unknown[] = [];
    if (retentionWorker !== undefined) {
      try {
        await retentionWorker.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (app !== undefined) {
      try {
        await app.close();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await dependencies.closePool(pool);
    } catch (error) {
      failures.push(error);
    }
    if (!ignoreFailures && failures.length > 0) {
      throw failures[0];
    }
  };

  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }
    app!.log.info({ signal }, "Shutting down EventHub");
    shutdownPromise = releaseResources(false);
    return shutdownPromise;
  };

  try {
    const database = dependencies.createDatabase(pool);
    if (config.migrateOnStart) {
      await dependencies.runMigrations(pool);
    }
    const bootstrap = await dependencies.ensureBootstrapTenantAndClient(
      {
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
      },
      database,
    );

    app = await dependencies.buildApp({ config, pool, database });
    if (config.usesInsecureDevelopmentSecrets) {
      app.log.warn(
        "EventHub is using development admin/API/webhook secrets; replace them before exposing the service",
      );
    }
    app.log.info(
      {
        tenantId: bootstrap.tenantId,
        apiClientId: bootstrap.apiClient.id,
        sourceConnectionId: bootstrap.sourceConnectionId,
      },
      "Bootstrap tenant and credentials are ready",
    );

    retentionWorker = dependencies.createRetentionWorker(database, app.log);
    retentionWorker.start();
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    dependencies.reportError(error);
    shutdownPromise = releaseResources(true);
    await shutdownPromise;
    dependencies.setExitCode(1);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    dependencies.registerSignal(signal, async () => {
      try {
        await shutdown(signal);
      } catch (error) {
        dependencies.reportError(error);
        dependencies.setExitCode(1);
      }
    });
  }

  return { shutdown };
}

import { loadEnvFile } from "node:process";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export interface AppConfig {
  readonly nodeEnv: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly databaseQueryTimeoutMs: number;
  readonly migrateOnStart: boolean;
  readonly bootstrapTenantId: string;
  readonly bootstrapTenantName: string;
  readonly bootstrapApiKey: string;
  /**
   * Operator credential for the management API. This is deliberately
   * independent from application API clients and is never persisted in
   * PostgreSQL.
   */
  readonly adminApiKey: string;
  readonly bootstrapWebhookConnectionId: string;
  readonly bootstrapWebhookSecret: string;
  readonly eventRetentionDays: number;
  readonly maxEventBytes: number;
  readonly sseBatchSize: number;
  readonly ssePollIntervalMs: number;
  readonly sseHeartbeatIntervalMs: number;
  readonly sseWriteTimeoutMs: number;
  readonly webhookMaxClockSkewSeconds: number;
  readonly usesInsecureDevelopmentSecrets: boolean;
}

const DEVELOPMENT_API_KEY = "dev-api-key-change-me";
const DEVELOPMENT_ADMIN_API_KEY = "dev-admin-api-key-change-me";
const DEVELOPMENT_WEBHOOK_SECRET = "dev-webhook-secret-change-me";
const PRODUCTION_API_KEY_MINIMUM_LENGTH = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOG_LEVELS = new Set<LogLevel>([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

export function loadLocalEnvironment(path = ".env"): void {
  try {
    loadEnvFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const bootstrapApiKey = parseApiKey(
    env.BOOTSTRAP_API_KEY ?? DEVELOPMENT_API_KEY,
    "BOOTSTRAP_API_KEY",
  );
  const bootstrapWebhookSecret = parseSecret(
    env.BOOTSTRAP_WEBHOOK_SECRET ?? DEVELOPMENT_WEBHOOK_SECRET,
    "BOOTSTRAP_WEBHOOK_SECRET",
    16,
  );
  const adminApiKey = parseAdminApiKey(
    env.ADMIN_API_KEY ?? DEVELOPMENT_ADMIN_API_KEY,
    "ADMIN_API_KEY",
  );
  if (adminApiKey === bootstrapApiKey) {
    throw new Error("ADMIN_API_KEY must differ from BOOTSTRAP_API_KEY");
  }

  const insecureDevelopmentCredentialNames = getInsecureDevelopmentCredentialNames(
    bootstrapApiKey,
    adminApiKey,
    bootstrapWebhookSecret,
  );
  if (nodeEnv === "production") {
    if (insecureDevelopmentCredentialNames.length > 0) {
      throw new Error(
        `NODE_ENV=production must configure non-development credentials for ${insecureDevelopmentCredentialNames.join(", ")}; built-in development credentials are not allowed`,
      );
    }
    if (bootstrapApiKey.length < PRODUCTION_API_KEY_MINIMUM_LENGTH) {
      throw new Error(
        `NODE_ENV=production requires BOOTSTRAP_API_KEY to contain at least ${PRODUCTION_API_KEY_MINIMUM_LENGTH} printable ASCII characters without spaces`,
      );
    }
    if (adminApiKey.length < PRODUCTION_API_KEY_MINIMUM_LENGTH) {
      throw new Error(
        `NODE_ENV=production requires ADMIN_API_KEY to contain at least ${PRODUCTION_API_KEY_MINIMUM_LENGTH} printable ASCII characters without spaces`,
      );
    }
  }

  return {
    nodeEnv,
    host: env.HOST ?? "0.0.0.0",
    port: parseInteger(env.PORT, 3000, "PORT", 1, 65_535),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    databaseUrl:
      env.DATABASE_URL ?? "postgres://eventhub:eventhub@localhost:5433/eventhub",
    databasePoolMax: parseInteger(
      env.DATABASE_POOL_MAX,
      10,
      "DATABASE_POOL_MAX",
      2,
      100,
    ),
    databaseConnectionTimeoutMs: parseInteger(
      env.DATABASE_CONNECTION_TIMEOUT_MS,
      5000,
      "DATABASE_CONNECTION_TIMEOUT_MS",
      100,
      60_000,
    ),
    databaseQueryTimeoutMs: parseInteger(
      env.DATABASE_QUERY_TIMEOUT_MS,
      30_000,
      "DATABASE_QUERY_TIMEOUT_MS",
      100,
      120_000,
    ),
    migrateOnStart: parseBoolean(env.MIGRATE_ON_START, true),
    bootstrapTenantId: parseUuid(
      env.BOOTSTRAP_TENANT_ID ?? "00000000-0000-4000-8000-000000000001",
      "BOOTSTRAP_TENANT_ID",
    ),
    bootstrapTenantName: env.BOOTSTRAP_TENANT_NAME ?? "Default tenant",
    bootstrapApiKey,
    adminApiKey,
    bootstrapWebhookConnectionId: parseUuid(
      env.BOOTSTRAP_WEBHOOK_CONNECTION_ID ?? "00000000-0000-4000-8000-000000000002",
      "BOOTSTRAP_WEBHOOK_CONNECTION_ID",
    ),
    bootstrapWebhookSecret,
    eventRetentionDays: parseInteger(
      env.EVENT_RETENTION_DAYS,
      30,
      "EVENT_RETENTION_DAYS",
      30,
      3650,
    ),
    maxEventBytes: parseInteger(
      env.MAX_EVENT_BYTES,
      1_048_576,
      "MAX_EVENT_BYTES",
      1024,
      1_048_576,
    ),
    sseBatchSize: parseInteger(env.SSE_BATCH_SIZE, 200, "SSE_BATCH_SIZE", 1, 1000),
    ssePollIntervalMs: parseInteger(
      env.SSE_POLL_INTERVAL_MS,
      5000,
      "SSE_POLL_INTERVAL_MS",
      250,
      5000,
    ),
    sseHeartbeatIntervalMs: parseInteger(
      env.SSE_HEARTBEAT_INTERVAL_MS,
      15_000,
      "SSE_HEARTBEAT_INTERVAL_MS",
      1000,
      15_000,
    ),
    sseWriteTimeoutMs: parseInteger(
      env.SSE_WRITE_TIMEOUT_MS,
      30_000,
      "SSE_WRITE_TIMEOUT_MS",
      100,
      30_000,
    ),
    webhookMaxClockSkewSeconds: parseInteger(
      env.WEBHOOK_MAX_CLOCK_SKEW_SECONDS,
      300,
      "WEBHOOK_MAX_CLOCK_SKEW_SECONDS",
      0,
      300,
    ),
    usesInsecureDevelopmentSecrets: insecureDevelopmentCredentialNames.length > 0,
  };
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Expected a boolean value, received ${value}`);
}

function parseUuid(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${name} must be a valid UUID`);
  }
  return value;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = value ?? "info";
  if (!LOG_LEVELS.has(level as LogLevel)) {
    throw new Error(`LOG_LEVEL is invalid: ${level}`);
  }
  return level as LogLevel;
}

function parseSecret(value: string, name: string, minimumLength: number): string {
  if (value.length < minimumLength || value.trim().length === 0) {
    throw new Error(`${name} must contain at least ${minimumLength} characters`);
  }
  return value;
}

function parseApiKey(value: string, name: string): string {
  if (!/^[\x21-\x7e]{8,}$/.test(value)) {
    throw new Error(`${name} must contain at least 8 printable ASCII characters without spaces`);
  }
  return value;
}

function parseAdminApiKey(value: string, name: string): string {
  const apiKey = parseApiKey(value, name);
  if (apiKey.startsWith("ehk_")) {
    throw new Error(`${name} must not use the ehk_ application API key prefix`);
  }
  return apiKey;
}

function getInsecureDevelopmentCredentialNames(
  bootstrapApiKey: string,
  adminApiKey: string,
  bootstrapWebhookSecret: string,
): readonly string[] {
  const names: string[] = [];
  if (bootstrapApiKey === DEVELOPMENT_API_KEY) {
    names.push("BOOTSTRAP_API_KEY");
  }
  if (adminApiKey === DEVELOPMENT_ADMIN_API_KEY) {
    names.push("ADMIN_API_KEY");
  }
  if (bootstrapWebhookSecret === DEVELOPMENT_WEBHOOK_SECRET) {
    names.push("BOOTSTRAP_WEBHOOK_SECRET");
  }
  return names;
}

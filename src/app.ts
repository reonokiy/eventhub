import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "./config.js";
import { createDatabase, type Database } from "./db/database.js";
import { CloudEventValidationError } from "./domain/cloud-event.js";
import { CursorValidationError } from "./domain/cursor.js";
import { EventFilterValidationError } from "./domain/filters.js";
import { createAuthenticator, type ApiClientAuthenticator } from "./http/auth.js";
import { createAdminAuthenticator } from "./http/admin-auth.js";
import { HttpError } from "./http/errors.js";
import { registerJsonBodyParser } from "./http/raw-body.js";
import { generateRequestId } from "./http/request-id.js";
import { registerEventRoutes } from "./http/routes/events.js";
import {
  createDatabaseAdminRepository,
  registerAdminRoutes,
  type AdminRepository,
} from "./http/routes/admin.js";
import { registerHealthRoutes } from "./http/routes/health.js";
import { registerWebhookRoutes } from "./http/routes/webhooks.js";
import {
  PostgresNotifier,
  type EventNotifier,
} from "./realtime/notifier.js";
import type { SourceConnectionStore } from "./service/connections.js";
import type { EventStore } from "./service/event-store.js";
import {
  PostgresApiClientAuthenticator,
  PostgresSourceConnectionStore,
} from "./storage/postgres-auth.js";
import { PostgresEventStore } from "./storage/postgres-event-store.js";

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly pool: Pool;
  readonly database?: Database;
  readonly eventStore?: EventStore;
  readonly apiClientAuthenticator?: ApiClientAuthenticator;
  readonly adminRepository?: AdminRepository;
  readonly connectionStore?: SourceConnectionStore;
  readonly notifier?: EventNotifier;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, pool } = options;
  const database = options.database ?? createDatabase(pool);
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.maxEventBytes,
    genReqId: generateRequestId,
    forceCloseConnections: "idle",
  });
  app.decorateRequest("rawBody", undefined);
  app.decorateRequest("auth", undefined);
  registerJsonBodyParser(app, config.maxEventBytes);

  app.addHook("onSend", async (request, reply) => {
    if (!reply.hasHeader("X-Request-ID")) {
      reply.header("X-Request-ID", request.id);
    }
  });
  registerErrorHandling(app);

  const eventStore =
    options.eventStore ?? new PostgresEventStore(database, config.eventRetentionDays);
  const apiClients =
    options.apiClientAuthenticator ?? new PostgresApiClientAuthenticator(database);
  const connectionStore =
    options.connectionStore ?? new PostgresSourceConnectionStore(database);
  const authenticate = createAuthenticator(apiClients);
  const adminRepository =
    options.adminRepository ?? createDatabaseAdminRepository(database);
  const authenticateAdmin = createAdminAuthenticator(config.adminApiKey);

  let ownedNotifier: PostgresNotifier | undefined;
  const notifier =
    options.notifier ??
    (ownedNotifier = new PostgresNotifier(pool, app.log));
  if (ownedNotifier !== undefined) {
    await ownedNotifier.start();
    app.addHook("onClose", async () => ownedNotifier?.stop());
  }

  registerHealthRoutes(app, database);
  registerAdminRoutes(app, { authenticateAdmin, repository: adminRepository });
  registerEventRoutes(app, {
    config,
    eventStore,
    notifier,
    authenticate,
    verifyActiveCredential: (keyHash) => apiClients.verifyActiveClientByKeyHash(keyHash),
  });
  registerWebhookRoutes(app, { config, eventStore, connectionStore });

  app.setNotFoundHandler(async (request, reply) => {
    const error = new HttpError(404, "not_found", "The requested resource does not exist");
    return reply
      .code(error.statusCode)
      .type("application/problem+json")
      .send(error.toBody(request.id));
  });
  return app;
}

function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(async (error: FastifyError | Error, request, reply) => {
    const httpError = mapError(error);
    if (httpError.statusCode >= 500) {
      request.log.error({ err: error }, "Request failed");
    } else {
      request.log.info({ err: error, code: httpError.code }, "Request rejected");
    }
    return reply
      .code(httpError.statusCode)
      .type("application/problem+json")
      .send(httpError.toBody(request.id));
  });
}

function mapError(error: FastifyError | Error): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof CloudEventValidationError) {
    return new HttpError(
      400,
      "invalid_event",
      error.validationErrors[0] ?? error.message,
      error.validationErrors,
    );
  }
  if (error instanceof CursorValidationError) {
    return new HttpError(400, "invalid_cursor", error.message);
  }
  if (error instanceof EventFilterValidationError) {
    return new HttpError(400, "invalid_filter", error.message);
  }
  if (error instanceof SyntaxError) {
    return new HttpError(400, "invalid_json", "Request body must contain valid JSON");
  }

  const fastifyCode = (error as FastifyError).code;
  const statusCode = (error as FastifyError).statusCode;
  if (fastifyCode === "FST_ERR_CTP_BODY_TOO_LARGE" || statusCode === 413) {
    return new HttpError(413, "payload_too_large", "Request body exceeds the configured limit");
  }
  if (fastifyCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || statusCode === 415) {
    return new HttpError(415, "unsupported_media_type", "Content-Type is not supported");
  }
  if (isPostgresAvailabilityError(error)) {
    return new HttpError(503, "storage_unavailable", "PostgreSQL is temporarily unavailable");
  }
  return new HttpError(500, "internal_error", "The server could not complete the request");
}

function isPostgresAvailabilityError(error: unknown): boolean {
  let current = error;
  const seen = new Set<object>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as { cause?: unknown; code?: unknown; message?: unknown };
    const { code, message } = record;
    if (
      (typeof code === "string" &&
        (code.startsWith("08") ||
          code === "57P01" ||
          code === "57P02" ||
          code === "57P03" ||
          ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].includes(code))) ||
      (typeof message === "string" &&
        /timeout exceeded when trying to connect|connection terminated|query read timeout/i.test(message))
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

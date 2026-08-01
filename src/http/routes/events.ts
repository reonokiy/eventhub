import { once } from "node:events";
import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import {
  assertPublishableCloudEvent,
} from "../../domain/cloud-event.js";
import { canonicalJsonSha256 } from "../../domain/canonical-json.js";
import {
  CursorValidationError,
  formatCursor,
  INITIAL_CURSOR,
  parseCursor,
} from "../../domain/cursor.js";
import { parseEventFilters, type EventFilters } from "../../domain/filters.js";
import type { JsonValue } from "../../domain/json.js";
import type { EventNotifier } from "../../realtime/notifier.js";
import type { EventStore, StoredEvent, TenantCursorBounds } from "../../service/event-store.js";
import { toPublicCloudEvent } from "../../service/public-event.js";
import type { AuthenticatedClient } from "../auth.js";
import { requireScope } from "../auth.js";
import { requireContentType } from "../content-type.js";
import { HttpError } from "../errors.js";
import { firstHeader, parseLimit } from "../query.js";
import { parseJsonBody } from "../raw-body.js";
import { hashApiKey, parseBearerToken } from "../../security/api-key.js";

export interface EventRouteDependencies {
  readonly config: AppConfig;
  readonly eventStore: EventStore;
  readonly notifier: EventNotifier;
  readonly authenticate: (request: FastifyRequest) => Promise<AuthenticatedClient>;
  /** Rechecks a credential without refreshing its last-used timestamp. */
  readonly verifyActiveCredential: (
    keyHash: string,
  ) => Promise<AuthenticatedClient | undefined>;
}

export function registerEventRoutes(
  app: FastifyInstance,
  dependencies: EventRouteDependencies,
): void {
  const { config, eventStore, notifier, authenticate, verifyActiveCredential } = dependencies;
  const activeStreams = new Set<{
    readonly abortController: AbortController;
    readonly response: ServerResponse;
  }>();

  app.addHook("preClose", async () => {
    for (const stream of activeStreams) {
      stream.abortController.abort();
      if (!stream.response.writableEnded) {
        stream.response.end();
      }
    }
    activeStreams.clear();
  });

  app.post("/v1/events", async (request, reply) => {
    requireContentType(request.headers["content-type"], "application/cloudevents+json");
    const client = await authenticate(request);
    requireScope(client, "events:write");
    const event = assertPublishableCloudEvent(parseJsonBody(request.body));
    const idempotencyKey = parseIdempotencyKey(firstHeader(request.headers["idempotency-key"]));
    const requestHash = canonicalJsonSha256(event as JsonValue);

    const result = await eventStore.append({
      tenantId: client.tenantId,
      apiClientId: client.clientId,
      event,
      requestHash,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    if (result.status === "identity_conflict") {
      throw new HttpError(
        409,
        "event_identity_conflict",
        "The same source and id are already stored with a different event",
      );
    }
    if (result.status === "idempotency_conflict") {
      throw new HttpError(
        409,
        "idempotency_key_conflict",
        "The Idempotency-Key is already associated with a different request",
      );
    }
    const stored = requireStoredEvent(result.storedEvent);
    reply
      .code(result.status === "inserted" ? 201 : 200)
      .header("Location", `/v1/events/${formatCursor(stored.offset)}`)
      .header("Content-Type", "application/cloudevents+json; charset=utf-8");
    if (result.status === "duplicate") {
      reply.header("Idempotent-Replayed", "true");
    }
    return toPublicCloudEvent(stored);
  });

  app.get("/v1/events/:offset", async (request, reply) => {
    const client = await authenticate(request);
    requireScope(client, "events:read");
    const parameters = request.params as { offset?: unknown };
    const offset = parsePathOffset(parameters.offset);
    if (offset === undefined || offset === 0n) {
      throw new HttpError(400, "invalid_offset", "offset must be a positive integer");
    }
    const stored = await eventStore.getByOffset(client.tenantId, offset);
    if (stored === undefined) {
      throw new HttpError(404, "event_not_found", "The requested event does not exist");
    }
    reply.header("Content-Type", "application/cloudevents+json; charset=utf-8");
    return toPublicCloudEvent(stored);
  });

  app.get("/v1/events", async (request) => {
    const client = await authenticate(request);
    requireScope(client, "events:read");
    const query = request.query as Record<string, unknown>;
    const after = parseCursor(query.after) ?? INITIAL_CURSOR;
    const limit = parseLimit(query.limit);
    const filters = parseEventFilters(query);
    const bounds = await eventStore.getCursorBounds(client.tenantId);
    assertCursorAvailable(after, bounds);
    assertCursorNotAhead(after, bounds);

    const events = await eventStore.list({
      tenantId: client.tenantId,
      after,
      through: bounds.headOffset,
      limit,
      filters,
    });
    let nextAfter = bounds.headOffset;
    let hasMore = false;
    if (events.length === limit) {
      nextAfter = events.at(-1)?.offset ?? after;
      hasMore = await eventStore.hasMatchingEvent({
        tenantId: client.tenantId,
        after: nextAfter,
        through: bounds.headOffset,
        limit: 1,
        filters,
      });
      if (!hasMore) {
        nextAfter = bounds.headOffset;
      }
    }
    const finalBounds = await eventStore.getCursorBounds(client.tenantId);
    assertCursorWindowStable(after, finalBounds);

    return {
      events: events.map(toPublicCloudEvent),
      page: {
        after: formatCursor(after),
        next_after: formatCursor(nextAfter),
        head_offset: formatCursor(bounds.headOffset),
        minimum_available_offset: formatCursor(bounds.minimumAvailableOffset),
        has_more: hasMore,
      },
    };
  });

  app.get("/v1/events/stream", async (request, reply) => {
    assertSseAcceptHeader(request.headers.accept);
    const client = await authenticate(request);
    requireScope(client, "events:read");
    // authenticate() has already validated this header. Keep only its digest for
    // the lifetime of the stream so a later rotation invalidates this exact key.
    const credentialHash = hashApiKey(parseBearerToken(request.headers.authorization));
    const isCredentialActive = (): Promise<boolean> =>
      isActiveStreamCredential(verifyActiveCredential, credentialHash);
    const query = request.query as Record<string, unknown>;
    const queryCursor = parseCursor(query.after);
    const headerCursor = parseCursor(firstHeader(request.headers["last-event-id"]), "Last-Event-ID");
    const filters = parseEventFilters(query);
    const initialBounds = await eventStore.getCursorBounds(client.tenantId);
    let cursor = headerCursor ?? queryCursor ?? initialBounds.headOffset;
    assertCursorAvailable(cursor, initialBounds);
    assertCursorNotAhead(cursor, initialBounds);

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Request-ID": request.id,
    });
    response.setTimeout(0);
    response.flushHeaders();

    const abortController = new AbortController();
    const activeStream = { abortController, response };
    activeStreams.add(activeStream);
    request.raw.once("close", () => abortController.abort());
    let lastHeartbeatAt = Date.now();

    const closeForInactiveCredential = (): void => {
      request.log.info(
        { tenantId: client.tenantId, clientId: client.clientId },
        "Closing SSE connection because its credential is no longer active",
      );
      abortController.abort();
    };

    try {
      await writeSse(response, "retry: 3000\n\n", config.sseWriteTimeoutMs);
      while (!abortController.signal.aborted) {
        // This bounds an idle stream's revocation latency by its poll interval.
        if (!(await isCredentialActive())) {
          closeForInactiveCredential();
          break;
        }
        const wake = notifier.waitForTenant(
          client.tenantId,
          config.ssePollIntervalMs,
          abortController.signal,
        );
        const bounds = await eventStore.getCursorBounds(client.tenantId);
        if (cursor > 0n && cursor < bounds.minimumAvailableOffset - 1n) {
          request.log.warn(
            { cursor: formatCursor(cursor), minimum: formatCursor(bounds.minimumAvailableOffset) },
            "Closing SSE connection because its cursor expired",
          );
          break;
        }
        const progress = await streamThroughHead({
          eventStore,
          response,
          tenantId: client.tenantId,
          cursor,
          headOffset: bounds.headOffset,
          filters,
          batchSize: config.sseBatchSize,
          writeTimeoutMs: config.sseWriteTimeoutMs,
          isCredentialActive,
        });
        cursor = progress.cursor;
        if (!progress.credentialActive) {
          closeForInactiveCredential();
          break;
        }

        const reason = await wake;
        if (reason === "aborted") {
          break;
        }
        if (!(await isCredentialActive())) {
          closeForInactiveCredential();
          break;
        }
        if (Date.now() - lastHeartbeatAt >= config.sseHeartbeatIntervalMs) {
          await writeSse(response, ": keepalive\n\n", config.sseWriteTimeoutMs);
          lastHeartbeatAt = Date.now();
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        request.log.warn({ err: error, cursor: formatCursor(cursor) }, "SSE connection closed");
      }
    } finally {
      activeStreams.delete(activeStream);
      if (!response.writableEnded) {
        response.end();
      }
    }
  });
}

interface StreamThroughHeadInput {
  readonly eventStore: EventStore;
  readonly response: ServerResponse;
  readonly tenantId: string;
  readonly cursor: bigint;
  readonly headOffset: bigint;
  readonly filters: EventFilters;
  readonly batchSize: number;
  readonly writeTimeoutMs: number;
  /** Must validate the exact credential that opened this stream. */
  readonly isCredentialActive: () => Promise<boolean>;
}

interface StreamProgress {
  readonly cursor: bigint;
  readonly credentialActive: boolean;
}

async function streamThroughHead(input: StreamThroughHeadInput): Promise<StreamProgress> {
  let cursor = input.cursor;
  while (cursor < input.headOffset) {
    // Recheck before every batch so a revoked key cannot begin another read.
    if (!(await input.isCredentialActive())) {
      return { cursor, credentialActive: false };
    }
    const events = await input.eventStore.list({
      tenantId: input.tenantId,
      after: cursor,
      through: input.headOffset,
      limit: input.batchSize,
      filters: input.filters,
    });
    const currentBounds = await input.eventStore.getCursorBounds(input.tenantId);
    assertCursorWindowStable(cursor, currentBounds);
    for (const event of events) {
      // A large backlog may span many seconds; do not let a revocation mid-batch
      // continue delivering the rest of it.
      if (!(await input.isCredentialActive())) {
        return { cursor, credentialActive: false };
      }
      await writeSse(input.response, businessEventFrame(event), input.writeTimeoutMs);
      cursor = event.offset;
    }
    if (events.length < input.batchSize) {
      if (cursor < input.headOffset) {
        cursor = input.headOffset;
      }
      break;
    }
  }
  return { cursor, credentialActive: true };
}

async function isActiveStreamCredential(
  verifyActiveCredential: EventRouteDependencies["verifyActiveCredential"],
  credentialHash: string,
): Promise<boolean> {
  // key_hash is unique, so an active row for this digest necessarily represents
  // the exact credential that established the stream.
  const current = await verifyActiveCredential(credentialHash);
  return current !== undefined && current.scopes.includes("events:read");
}

function businessEventFrame(stored: StoredEvent): string {
  const event = toPublicCloudEvent(stored);
  return [
    `id: ${formatCursor(stored.offset)}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");
}

async function writeSse(
  response: ServerResponse,
  data: string,
  timeoutMs: number,
): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new Error("SSE connection is closed");
  }
  if (response.writableLength + Buffer.byteLength(data) > 1_048_576) {
    throw new Error("SSE client exceeded the pending write buffer limit");
  }
  if (response.write(data)) {
    return;
  }

  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSE client write timed out")), timeoutMs);
    timer.unref();
  });
  await Promise.race([once(response, "drain"), timeout]);
}

function parseIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[\x20-\x7e]{1,255}$/.test(value) || value.trim().length === 0) {
    throw new HttpError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must contain 1 to 255 printable ASCII characters",
    );
  }
  return value;
}

function parsePathOffset(value: unknown): bigint | undefined {
  try {
    return parseCursor(value, "offset");
  } catch (error) {
    throw mapPathOffsetError(error);
  }
}

export function mapPathOffsetError(error: unknown): HttpError {
  if (error instanceof CursorValidationError) {
    return new HttpError(400, "invalid_offset", error.message);
  }
  throw error;
}

function assertCursorAvailable(cursor: bigint, bounds: TenantCursorBounds): void {
  if (cursor > 0n && cursor < bounds.minimumAvailableOffset - 1n) {
    throwCursorExpired(bounds);
  }
}

function assertCursorWindowStable(
  cursor: bigint,
  currentBounds: TenantCursorBounds,
): void {
  if (cursor > 0n && cursor < currentBounds.minimumAvailableOffset - 1n) {
    throwCursorExpired(currentBounds);
  }
}

function throwCursorExpired(bounds: TenantCursorBounds): never {
  throw new HttpError(
    410,
    "cursor_expired",
    "The cursor is older than the retained event window",
    undefined,
    {
      minimum_available_offset: formatCursor(bounds.minimumAvailableOffset),
      head_offset: formatCursor(bounds.headOffset),
    },
  );
}

function assertCursorNotAhead(cursor: bigint, bounds: TenantCursorBounds): void {
  if (cursor > bounds.headOffset) {
    throw new HttpError(
      400,
      "cursor_ahead",
      "The cursor is greater than the current tenant head",
      undefined,
      { head_offset: formatCursor(bounds.headOffset) },
    );
  }
}

function assertSseAcceptHeader(accept: string | undefined): void {
  if (
    accept !== undefined &&
    !accept.split(",").some((value) => {
      const mediaType = value.split(";", 1)[0]?.trim();
      return mediaType === "*/*" || mediaType === "text/event-stream";
    })
  ) {
    throw new HttpError(406, "not_acceptable", "Accept must allow text/event-stream");
  }
}

function requireStoredEvent(stored: StoredEvent | undefined): StoredEvent {
  if (stored === undefined) {
    throw new Error("Event store returned no event for a successful append");
  }
  return stored;
}

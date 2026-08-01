import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { QueryResultRow } from "pg";

import { canonicalJsonSha256 } from "../domain/canonical-json.js";
import type { JsonValue } from "../domain/json.js";
import { getDatabase, type Database } from "./database.js";
import { events, tenantHeads, tenants } from "./schema.js";
import type {
  AppendEventInput,
  AppendEventResult,
  EventPage,
  EventReplayReason,
  JsonObject,
  ListEventsInput,
  OffsetInput,
  StoredEvent,
  TenantEventBounds,
} from "./types.js";

const MAX_BIGINT = 9_223_372_036_854_775_807n;

interface EventRow {
  readonly tenantId: string;
  readonly offset: string | bigint;
  readonly stream: string;
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly subject: string | null;
  readonly occurredAt: Date | string | null;
  readonly receivedAt: Date | string;
  readonly datacontenttype: string;
  readonly dataschema: string | null;
  readonly data: JsonValue;
  readonly attributes: JsonObject;
  readonly envelopeHash: string;
}

interface AppendEventRow extends QueryResultRow, EventRow {
  readonly inserted: boolean;
  readonly replayReason: EventReplayReason | null;
}

export async function appendEvent(
  input: AppendEventInput,
  database: Database = getDatabase(),
): Promise<AppendEventResult> {
  const envelopeHash = input.envelopeHash ?? computeEnvelopeHash(input);
  const idempotency = input.idempotency;
  const retentionDays = idempotency?.retentionDays ?? 30;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 30 || retentionDays > 3650) {
    throw new RangeError("idempotency retentionDays must be an integer between 30 and 3650");
  }
  assertSha256(envelopeHash, "envelopeHash");
  if (idempotency !== undefined) {
    assertSha256(idempotency.keyHash, "idempotency.keyHash");
    if (idempotency.requestHash !== undefined) {
      assertSha256(idempotency.requestHash, "idempotency.requestHash");
    }
  }

  const attributes = input.attributes ?? {};
  const requestHash = idempotency?.requestHash ?? envelopeHash;

  try {
    const result = await database.execute<AppendEventRow>(sql`
      SELECT
        tenant_id AS "tenantId",
        "offset"::text AS "offset",
        stream,
        specversion,
        id,
        source,
        type,
        subject,
        occurred_at AS "occurredAt",
        received_at AS "receivedAt",
        datacontenttype,
        dataschema,
        data,
        attributes,
        envelope_hash AS "envelopeHash",
        inserted,
        replay_reason AS "replayReason"
      FROM eventhub_append_event(
        ${input.tenantId}::uuid,
        ${input.stream}::text,
        ${input.id}::text,
        ${input.source}::text,
        ${input.type}::text,
        ${JSON.stringify(input.data)}::jsonb,
        ${input.specversion ?? "1.0"}::text,
        ${input.subject ?? null}::text,
        ${input.occurredAt ?? null}::timestamptz,
        ${input.datacontenttype ?? "application/json"}::text,
        ${input.dataschema ?? null}::text,
        ${JSON.stringify(attributes)}::jsonb,
        ${envelopeHash}::text,
        ${idempotency?.apiClientId ?? null}::uuid,
        ${idempotency?.keyHash ?? null}::text,
        ${idempotency === undefined ? null : requestHash}::text,
        ${`${retentionDays} days`}::interval
      )
    `);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("eventhub_append_event returned no event");
    }
    return {
      event: mapEvent(row),
      inserted: row.inserted,
      replayReason: row.replayReason,
    };
  } catch (error) {
    if (isDatabaseError(error, "P0001", "event_identity_conflict")) {
      throw new EventIdentityConflictError(input.source, input.id, { cause: error });
    }
    if (isDatabaseError(error, "P0001", "idempotency_key_conflict")) {
      throw new IdempotencyKeyConflictError({ cause: error });
    }
    throw error;
  }
}

export async function listEvents(
  input: ListEventsInput,
  database: Database = getDatabase(),
): Promise<EventPage> {
  const after = normalizeOffset(input.after ?? 0n, "after");
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError("limit must be an integer between 1 and 1000");
  }

  const observedHighWaterMark = await getTenantHighWaterMark(input.tenantId, database);
  const requestedHighWaterMark =
    input.highWaterMark === undefined
      ? observedHighWaterMark
      : normalizeOffset(input.highWaterMark, "highWaterMark");
  if (BigInt(requestedHighWaterMark) > BigInt(observedHighWaterMark)) {
    throw new CursorAheadError(requestedHighWaterMark, observedHighWaterMark);
  }
  if (BigInt(after) > BigInt(requestedHighWaterMark)) {
    throw new CursorAheadError(after, requestedHighWaterMark);
  }

  const streams = normalizeExactFilter("stream", input.stream);
  const types = normalizeExactFilter("type", input.type);
  const sources = normalizeExactFilter("source", input.source);
  const rows = await database
    .select()
    .from(events)
    .where(
      and(
        eq(events.tenantId, input.tenantId),
        gt(events.offset, BigInt(after)),
        lte(events.offset, BigInt(requestedHighWaterMark)),
        streams === undefined ? undefined : inArray(events.stream, streams),
        types === undefined ? undefined : inArray(events.type, types),
        sources === undefined ? undefined : inArray(events.source, sources),
      ),
    )
    .orderBy(asc(events.offset))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const storedEvents = rows.slice(0, limit).map(mapEvent);
  const lastEvent = storedEvents.at(-1);
  const nextAfter =
    hasMore && lastEvent !== undefined
      ? lastEvent.offset
      : requestedHighWaterMark;

  return {
    events: storedEvents,
    after,
    nextAfter,
    highWaterMark: requestedHighWaterMark,
    hasMore,
  };
}

export async function getEventByOffset(
  tenantId: string,
  offset: OffsetInput,
  database: Database = getDatabase(),
): Promise<StoredEvent | null> {
  const normalizedOffset = normalizeOffset(offset, "offset");
  if (normalizedOffset === "0") {
    return null;
  }
  const rows = await database
    .select()
    .from(events)
    .where(
      and(
        eq(events.tenantId, tenantId),
        eq(events.offset, BigInt(normalizedOffset)),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : mapEvent(row);
}

export async function getTenantHighWaterMark(
  tenantId: string,
  database: Database = getDatabase(),
): Promise<string> {
  const rows = await database
    .select({
      headOffset: sql<string>`coalesce(${tenantHeads.lastOffset}, 0)::text`,
    })
    .from(tenants)
    .leftJoin(tenantHeads, eq(tenantHeads.tenantId, tenants.id))
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new TenantNotFoundError(tenantId);
  }
  return row.headOffset;
}

export async function getTenantEventBounds(
  tenantId: string,
  database: Database = getDatabase(),
): Promise<TenantEventBounds> {
  const rows = await database
    .select({
      headOffset: sql<string>`coalesce(${tenantHeads.lastOffset}, 0)::text`,
      minimumAvailableOffset: sql<string>`
        coalesce(
          min(${events.offset})::text,
          (coalesce(${tenantHeads.lastOffset}, 0) + 1)::text
        )
      `,
    })
    .from(tenants)
    .leftJoin(tenantHeads, eq(tenantHeads.tenantId, tenants.id))
    .leftJoin(events, eq(events.tenantId, tenants.id))
    .where(eq(tenants.id, tenantId))
    .groupBy(tenants.id, tenantHeads.lastOffset)
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new TenantNotFoundError(tenantId);
  }
  return row;
}

export function hashIdempotencyKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function computeEnvelopeHash(input: AppendEventInput): string {
  const envelope: Record<string, JsonValue> = {
    ...(input.attributes ?? {}),
    specversion: input.specversion ?? "1.0",
    id: input.id,
    source: input.source,
    type: input.type,
    datacontenttype: input.datacontenttype ?? "application/json",
    eventhubstream: input.stream,
    data: input.data,
  };
  if (input.subject !== undefined && input.subject !== null) {
    envelope.subject = input.subject;
  }
  if (input.occurredAt !== undefined && input.occurredAt !== null) {
    envelope.time =
      input.occurredAt instanceof Date
        ? input.occurredAt.toISOString()
        : input.occurredAt;
  }
  if (input.dataschema !== undefined && input.dataschema !== null) {
    envelope.dataschema = input.dataschema;
  }
  return canonicalJsonSha256(envelope);
}

export class EventIdentityConflictError extends Error {
  public constructor(
    public readonly source: string,
    public readonly eventId: string,
    options?: ErrorOptions,
  ) {
    super(`An event with source ${source} and id ${eventId} already has different content`, options);
    this.name = "EventIdentityConflictError";
  }
}

export class IdempotencyKeyConflictError extends Error {
  public constructor(options?: ErrorOptions) {
    super("The idempotency key was already used for a different request", options);
    this.name = "IdempotencyKeyConflictError";
  }
}

export class CursorAheadError extends Error {
  public constructor(
    public readonly cursor: string,
    public readonly highWaterMark: string,
  ) {
    super(`Cursor ${cursor} is ahead of high-water mark ${highWaterMark}`);
    this.name = "CursorAheadError";
  }
}

export class TenantNotFoundError extends Error {
  public constructor(public readonly tenantId: string) {
    super(`Tenant ${tenantId} does not exist`);
    this.name = "TenantNotFoundError";
  }
}

function mapEvent(row: EventRow): StoredEvent {
  return {
    tenantId: row.tenantId,
    offset: String(row.offset),
    stream: row.stream,
    specversion: row.specversion,
    id: row.id,
    source: row.source,
    type: row.type,
    subject: row.subject,
    occurredAt: row.occurredAt === null ? null : toDate(row.occurredAt, "occurredAt"),
    receivedAt: toDate(row.receivedAt, "receivedAt"),
    datacontenttype: row.datacontenttype,
    dataschema: row.dataschema,
    data: row.data,
    attributes: row.attributes,
    envelopeHash: row.envelopeHash,
  };
}

function normalizeOffset(value: OffsetInput, name: string): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe non-negative integer`);
  }
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    throw new RangeError(`${name} must be a canonical non-negative integer`);
  }
  const parsed = BigInt(text);
  if (parsed > MAX_BIGINT) {
    throw new RangeError(`${name} exceeds the PostgreSQL bigint range`);
  }
  return text;
}

function toDate(value: Date | string, name: string): Date {
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`${name} from PostgreSQL is not a valid timestamp`);
  }
  return parsed;
}

function normalizeExactFilter(
  name: "stream" | "type" | "source",
  value: string | readonly string[] | undefined,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const values = typeof value === "string" ? [value] : [...value];
  if (values.length === 0 || values.some((item) => item.length === 0)) {
    throw new RangeError(`${name} filters must be non-empty strings`);
  }
  return values;
}

function assertSha256(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 hex digest`);
  }
}

function isDatabaseError(error: unknown, code: string, message: string): boolean {
  let current = error;
  const seen = new Set<object>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as { cause?: unknown; code?: unknown; message?: unknown };
    if (record.code === code && record.message === message) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

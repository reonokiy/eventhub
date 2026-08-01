import type { CloudEvent } from "../domain/cloud-event.js";
import type { JsonValue } from "../domain/json.js";
import type { Database } from "../db/database.js";
import {
  appendEvent,
  CursorAheadError,
  EventIdentityConflictError,
  getTenantEventBounds,
  hashIdempotencyKey,
  IdempotencyKeyConflictError,
  listEvents,
} from "../db/events.js";
import type { StoredEvent as DatabaseStoredEvent } from "../db/types.js";
import type {
  AppendEventCommand,
  AppendEventResult,
  EventPageQuery,
  EventStore,
  StoredEvent,
  TenantCursorBounds,
} from "../service/event-store.js";

const CORE_ATTRIBUTES = new Set([
  "specversion",
  "id",
  "source",
  "type",
  "subject",
  "time",
  "datacontenttype",
  "dataschema",
  "data",
  "eventhubstream",
  "eventhuboffset",
  "eventhubreceivedat",
]);

export class PostgresEventStore implements EventStore {
  readonly #database: Database;
  readonly #idempotencyRetentionDays: number;

  public constructor(database: Database, idempotencyRetentionDays = 30) {
    this.#database = database;
    this.#idempotencyRetentionDays = Math.max(30, idempotencyRetentionDays);
  }

  public async append(command: AppendEventCommand): Promise<AppendEventResult> {
    const event = command.event;
    const stream = event.eventhubstream;
    if (typeof stream !== "string") {
      throw new TypeError("Validated event is missing eventhubstream");
    }

    try {
      const result = await appendEvent(
        {
          tenantId: command.tenantId,
          stream,
          id: event.id,
          source: event.source,
          type: event.type,
          data: event.data ?? null,
          specversion: event.specversion,
          ...(event.subject === undefined ? {} : { subject: event.subject }),
          ...(event.time === undefined
            ? {}
            : { occurredAt: new Date(event.time).toISOString() }),
          datacontenttype: event.datacontenttype ?? "application/json",
          ...(event.dataschema === undefined ? {} : { dataschema: event.dataschema }),
          attributes: extensionAttributes(event),
          envelopeHash: command.requestHash,
          ...(command.idempotencyKey === undefined || command.apiClientId === undefined
            ? {}
            : {
                idempotency: {
                  apiClientId: command.apiClientId,
                  keyHash: hashIdempotencyKey(command.idempotencyKey),
                  requestHash: command.requestHash,
                  retentionDays: this.#idempotencyRetentionDays,
                },
              }),
        },
        this.#database,
      );
      return {
        status: result.inserted ? "inserted" : "duplicate",
        storedEvent: mapDatabaseEvent(result.event),
      };
    } catch (error) {
      if (error instanceof EventIdentityConflictError) {
        return { status: "identity_conflict" };
      }
      if (error instanceof IdempotencyKeyConflictError) {
        return { status: "idempotency_conflict" };
      }
      throw error;
    }
  }

  public async getByOffset(tenantId: string, offset: bigint): Promise<StoredEvent | undefined> {
    if (offset < 1n) {
      return undefined;
    }
    try {
      const page = await listEvents(
        {
          tenantId,
          after: offset - 1n,
          highWaterMark: offset,
          limit: 1,
        },
        this.#database,
      );
      const event = page.events[0];
      return event === undefined ? undefined : mapDatabaseEvent(event);
    } catch (error) {
      if (error instanceof CursorAheadError) {
        return undefined;
      }
      throw error;
    }
  }

  public async list(query: EventPageQuery): Promise<readonly StoredEvent[]> {
    const page = await listEvents(
      {
        tenantId: query.tenantId,
        after: query.after,
        highWaterMark: query.through,
        limit: query.limit,
        ...(query.filters.stream === undefined ? {} : { stream: query.filters.stream }),
        ...(query.filters.type === undefined ? {} : { type: query.filters.type }),
        ...(query.filters.source === undefined ? {} : { source: query.filters.source }),
      },
      this.#database,
    );
    return page.events.map(mapDatabaseEvent);
  }

  public async hasMatchingEvent(query: EventPageQuery): Promise<boolean> {
    const events = await this.list({ ...query, limit: 1 });
    return events.length > 0;
  }

  public async getCursorBounds(tenantId: string): Promise<TenantCursorBounds> {
    const bounds = await getTenantEventBounds(tenantId, this.#database);
    return {
      headOffset: BigInt(bounds.headOffset),
      minimumAvailableOffset: BigInt(bounds.minimumAvailableOffset),
    };
  }
}

function mapDatabaseEvent(stored: DatabaseStoredEvent): StoredEvent {
  const event: CloudEvent = {
    ...stored.attributes,
    specversion: stored.specversion,
    id: stored.id,
    source: stored.source,
    type: stored.type,
    ...(stored.subject === null ? {} : { subject: stored.subject }),
    ...(stored.occurredAt === null ? {} : { time: stored.occurredAt.toISOString() }),
    datacontenttype: stored.datacontenttype,
    ...(stored.dataschema === null ? {} : { dataschema: stored.dataschema }),
    eventhubstream: stored.stream,
    data: stored.data,
  };
  return {
    tenantId: stored.tenantId,
    offset: BigInt(stored.offset),
    stream: stored.stream,
    receivedAt: stored.receivedAt,
    event,
  };
}

function extensionAttributes(event: CloudEvent): Readonly<Record<string, JsonValue>> {
  const attributes: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(event)) {
    if (!CORE_ATTRIBUTES.has(name) && value !== undefined) {
      attributes[name] = value;
    }
  }
  return attributes;
}

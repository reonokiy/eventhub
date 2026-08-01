import type { CloudEvent } from "../domain/cloud-event.js";
import type { EventFilters } from "../domain/filters.js";

export interface StoredEvent {
  readonly tenantId: string;
  readonly offset: bigint;
  readonly stream: string;
  readonly receivedAt: Date;
  readonly event: CloudEvent;
}

export interface AppendEventCommand {
  readonly tenantId: string;
  readonly event: CloudEvent;
  readonly requestHash: string;
  readonly apiClientId?: string;
  readonly idempotencyKey?: string;
}

export type AppendEventStatus =
  | "inserted"
  | "duplicate"
  | "identity_conflict"
  | "idempotency_conflict";

export interface AppendEventResult {
  readonly status: AppendEventStatus;
  readonly storedEvent?: StoredEvent;
}

export interface EventPageQuery {
  readonly tenantId: string;
  readonly after: bigint;
  readonly through: bigint;
  readonly limit: number;
  readonly filters: EventFilters;
}

export interface TenantCursorBounds {
  readonly headOffset: bigint;
  readonly minimumAvailableOffset: bigint;
}

export interface EventStore {
  append(command: AppendEventCommand): Promise<AppendEventResult>;
  getByOffset(tenantId: string, offset: bigint): Promise<StoredEvent | undefined>;
  list(query: EventPageQuery): Promise<readonly StoredEvent[]>;
  hasMatchingEvent(query: EventPageQuery): Promise<boolean>;
  getCursorBounds(tenantId: string): Promise<TenantCursorBounds>;
}

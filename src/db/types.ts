import type { JsonValue } from "../domain/json.js";

export type OffsetInput = bigint | number | string;
export type EventReplayReason = "idempotency_key" | "event_identity";
export type JsonObject = Readonly<Record<string, JsonValue>>;

export interface StoredEvent {
  readonly tenantId: string;
  readonly offset: string;
  readonly stream: string;
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly subject: string | null;
  readonly occurredAt: Date | null;
  readonly receivedAt: Date;
  readonly datacontenttype: string;
  readonly dataschema: string | null;
  readonly data: JsonValue;
  readonly attributes: JsonObject;
  readonly envelopeHash: string;
}

export interface PublishIdempotency {
  readonly apiClientId: string;
  readonly keyHash: string;
  readonly requestHash?: string;
  readonly retentionDays?: number;
}

export interface AppendEventInput {
  readonly tenantId: string;
  readonly stream: string;
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly data: JsonValue;
  readonly specversion?: "1.0";
  readonly subject?: string | null;
  readonly occurredAt?: Date | string | null;
  readonly datacontenttype?: string;
  readonly dataschema?: string | null;
  readonly attributes?: JsonObject;
  readonly envelopeHash?: string;
  readonly idempotency?: PublishIdempotency;
}

export interface AppendEventResult {
  readonly event: StoredEvent;
  readonly inserted: boolean;
  readonly replayReason: EventReplayReason | null;
}

export interface ListEventsInput {
  readonly tenantId: string;
  readonly after?: OffsetInput;
  readonly limit?: number;
  /** Reuse the first page's value to hold a stable pagination snapshot. */
  readonly highWaterMark?: OffsetInput;
  readonly stream?: string | readonly string[];
  readonly type?: string | readonly string[];
  readonly source?: string | readonly string[];
}

export interface EventPage {
  readonly events: readonly StoredEvent[];
  readonly after: string;
  readonly nextAfter: string;
  readonly highWaterMark: string;
  readonly hasMore: boolean;
}

export interface TenantEventBounds {
  readonly headOffset: string;
  readonly minimumAvailableOffset: string;
}

export interface ApiClientPrincipal {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
}

export interface SourceConnection {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly name: string;
  readonly stream: string;
  /** MVP plaintext value. Never log or return it from an HTTP endpoint. */
  readonly signingSecret: string | null;
  readonly config: JsonObject;
  readonly checkpoint: JsonValue | null;
}

export interface BootstrapWebhookConnection {
  readonly id: string;
  readonly secret: string;
  readonly provider?: string;
  readonly name?: string;
  readonly stream?: string;
  readonly config?: JsonObject;
}

export interface BootstrapOptions {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly apiKey: string;
  readonly tenantSlug?: string;
  readonly retentionDays?: number;
  readonly apiClientName?: string;
  readonly scopes?: readonly string[];
  readonly webhook?: BootstrapWebhookConnection;
}

export interface BootstrapResult {
  readonly tenantId: string;
  readonly apiClient: ApiClientPrincipal;
  readonly sourceConnectionId: string | null;
}


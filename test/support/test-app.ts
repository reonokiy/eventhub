import type { Pool } from "pg";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { JsonValue } from "../../src/domain/json.js";
import type { ApiClientAuthenticator, AuthenticatedClient } from "../../src/http/auth.js";
import type { AdminRepository } from "../../src/http/routes/admin.js";
import type { EventNotifier } from "../../src/realtime/notifier.js";
import type { SourceConnectionStore } from "../../src/service/connections.js";
import type { EventStore, StoredEvent } from "../../src/service/event-store.js";

export const TEST_CLIENT: AuthenticatedClient = {
  clientId: "00000000-0000-4000-8000-000000000010",
  tenantId: "00000000-0000-4000-8000-000000000020",
  name: "HTTP test client",
  scopes: ["events:read", "events:write"],
};

const config = loadConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgres://unused/when-dependencies-are-injected",
});

const pool = {
  async query() {
    return { rows: [{ ok: 1 }], rowCount: 1 };
  },
} as unknown as Pool;

const authenticator: ApiClientAuthenticator = {
  async findActiveClientByKeyHash() {
    return TEST_CLIENT;
  },
  async verifyActiveClientByKeyHash() {
    return TEST_CLIENT;
  },
};

const notifier: EventNotifier = {
  async waitForTenant() {
    return "aborted";
  },
};

const noConnections: SourceConnectionStore = {
  async findActiveConnection() {
    return undefined;
  },
};

interface TestAppOptions {
  readonly eventStore: EventStore;
  readonly apiClientAuthenticator?: ApiClientAuthenticator;
  readonly adminRepository?: AdminRepository;
  readonly connectionStore?: SourceConnectionStore;
  readonly notifier?: EventNotifier;
}

export function createTestApp(options: TestAppOptions) {
  return buildApp({
    config,
    pool,
    eventStore: options.eventStore,
    apiClientAuthenticator: options.apiClientAuthenticator ?? authenticator,
    ...(options.adminRepository === undefined
      ? {}
      : { adminRepository: options.adminRepository }),
    connectionStore: options.connectionStore ?? noConnections,
    notifier: options.notifier ?? notifier,
  });
}

interface StoredEventOverrides {
  readonly id?: string;
  readonly source?: string;
  readonly type?: string;
  readonly eventhubstream?: string;
  readonly data?: JsonValue;
}

export function storedEvent(
  offset: bigint,
  overrides: StoredEventOverrides = {},
): StoredEvent {
  const stream = overrides.eventhubstream ?? "orders";
  return {
    tenantId: TEST_CLIENT.tenantId,
    offset,
    stream,
    receivedAt: new Date("2026-08-01T13:20:00.000Z"),
    event: {
      specversion: "1.0",
      id: overrides.id ?? "event-42",
      source: overrides.source ?? "urn:test:publisher",
      type: overrides.type ?? "com.example.order.created.v1",
      datacontenttype: "application/json",
      eventhubstream: stream,
      data: overrides.data ?? { order_id: "order-42" },
    },
  };
}

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import type { JsonValue } from "../domain/json.js";
import type { JsonObject } from "./types.js";

export const tenants = pgTable("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  retentionDays: integer("retention_days").notNull().default(30),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .default(sql`clock_timestamp()`),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .default(sql`clock_timestamp()`),
});

export const apiClients = pgTable(
  "api_clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`ARRAY['events:read', 'events:write']::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    unique("api_clients_tenant_name_unique").on(table.tenantId, table.name),
    unique("api_clients_tenant_id_id_unique").on(table.tenantId, table.id),
    index("api_clients_tenant_revoked_idx").on(table.tenantId, table.revokedAt),
  ],
);

export const sourceConnections = pgTable(
  "source_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    stream: text("stream").notNull().default("default"),
    signingSecret: text("signing_secret"),
    config: jsonb("config")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    checkpoint: jsonb("checkpoint").$type<JsonValue>(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique("source_connections_tenant_provider_name_unique").on(
      table.tenantId,
      table.provider,
      table.name,
    ),
    index("source_connections_tenant_provider_active_idx").on(
      table.tenantId,
      table.provider,
      table.active,
    ),
  ],
);

export const tenantHeads = pgTable("tenant_heads", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  lastOffset: bigint("last_offset", { mode: "bigint" }).notNull().default(0n),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .default(sql`clock_timestamp()`),
});

export const events = pgTable(
  "events",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    offset: bigint("offset", { mode: "bigint" }).notNull(),
    stream: text("stream").notNull(),
    specversion: text("specversion", { enum: ["1.0"] }).notNull().default("1.0"),
    id: text("id").notNull(),
    source: text("source").notNull(),
    type: text("type").notNull(),
    subject: text("subject"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
    datacontenttype: text("datacontenttype").notNull().default("application/json"),
    dataschema: text("dataschema"),
    data: jsonb("data")
      .$type<JsonValue>()
      .notNull()
      .default(sql`'null'::jsonb`),
    attributes: jsonb("attributes")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    envelopeHash: text("envelope_hash").notNull(),
  },
  (table) => [
    primaryKey({ name: "events_pkey", columns: [table.tenantId, table.offset] }),
    unique("events_identity_unique").on(table.tenantId, table.source, table.id),
    index("events_tenant_stream_offset_idx").on(
      table.tenantId,
      table.stream,
      table.offset,
    ),
    index("events_tenant_type_offset_idx").on(table.tenantId, table.type, table.offset),
    index("events_tenant_source_offset_idx").on(
      table.tenantId,
      table.source,
      table.offset,
    ),
    index("events_tenant_received_at_idx").on(table.tenantId, table.receivedAt),
  ],
);

export const publishIdempotencyKeys = pgTable(
  "publish_idempotency_keys",
  {
    tenantId: uuid("tenant_id").notNull(),
    apiClientId: uuid("api_client_id").notNull(),
    keyHash: text("key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    eventOffset: bigint("event_offset", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "publish_idempotency_keys_pkey",
      columns: [table.tenantId, table.apiClientId, table.keyHash],
    }),
    foreignKey({
      name: "publish_idempotency_keys_client_fk",
      columns: [table.tenantId, table.apiClientId],
      foreignColumns: [apiClients.tenantId, apiClients.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "publish_idempotency_keys_event_fk",
      columns: [table.tenantId, table.eventOffset],
      foreignColumns: [events.tenantId, events.offset],
    }).onDelete("cascade"),
    index("publish_idempotency_keys_expiry_idx").on(table.expiresAt),
    index("publish_idempotency_keys_event_idx").on(table.tenantId, table.eventOffset),
  ],
);


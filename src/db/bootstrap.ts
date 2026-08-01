import { eq, sql } from "drizzle-orm";

import { hashApiKey } from "../security/api-key.js";
import { mapPrincipal } from "./auth.js";
import { getDatabase, type Database } from "./database.js";
import { apiClients, sourceConnections, tenantHeads, tenants } from "./schema.js";
import type { BootstrapOptions, BootstrapResult } from "./types.js";

const API_CLIENT_SCOPES = new Set(["events:read", "events:write"]);

export async function ensureBootstrapTenantAndClient(
  options: BootstrapOptions,
  database: Database = getDatabase(),
): Promise<BootstrapResult> {
  validateBootstrapOptions(options);

  return database.transaction(async (tx) => {
    await tx
      .insert(tenants)
      .values({
        id: options.tenantId,
        slug: options.tenantSlug ?? "default",
        name: options.tenantName,
        retentionDays: options.retentionDays ?? 30,
      })
      .onConflictDoUpdate({
        target: tenants.id,
        set: {
          name: options.tenantName,
          retentionDays: options.retentionDays ?? 30,
          updatedAt: sql`clock_timestamp()`,
        },
      });

    await tx
      .insert(tenantHeads)
      .values({ tenantId: options.tenantId, lastOffset: 0n })
      .onConflictDoNothing({ target: tenantHeads.tenantId });

    const clientRows = await tx
      .insert(apiClients)
      .values({
        tenantId: options.tenantId,
        name: options.apiClientName ?? "bootstrap",
        keyPrefix: options.apiKey.slice(0, 12),
        keyHash: hashApiKey(options.apiKey),
        scopes: [...(options.scopes ?? ["events:read", "events:write"])],
      })
      .onConflictDoUpdate({
        target: [apiClients.tenantId, apiClients.name],
        set: {
          keyPrefix: options.apiKey.slice(0, 12),
          keyHash: hashApiKey(options.apiKey),
          scopes: [...(options.scopes ?? ["events:read", "events:write"])],
          expiresAt: null,
          revokedAt: null,
          updatedAt: sql`clock_timestamp()`,
        },
      })
      .returning({
        id: apiClients.id,
        tenantId: apiClients.tenantId,
        name: apiClients.name,
        keyPrefix: apiClients.keyPrefix,
        scopes: apiClients.scopes,
        expiresAt: apiClients.expiresAt,
      });
    const clientRow = clientRows[0];
    if (clientRow === undefined) {
      throw new Error("Failed to ensure the bootstrap API client");
    }

    const webhook = options.webhook;
    let sourceConnectionId: string | null = null;
    if (webhook !== undefined) {
      const connectionRows = await tx
        .insert(sourceConnections)
        .values({
          id: webhook.id,
          tenantId: options.tenantId,
          provider: webhook.provider ?? "hmac",
          name: webhook.name ?? "bootstrap-hmac",
          stream: webhook.stream ?? "default",
          signingSecret: webhook.secret,
          config: webhook.config ?? {},
          active: true,
        })
        .onConflictDoUpdate({
          target: sourceConnections.id,
          set: {
            provider: webhook.provider ?? "hmac",
            name: webhook.name ?? "bootstrap-hmac",
            stream: webhook.stream ?? "default",
            signingSecret: webhook.secret,
            config: webhook.config ?? {},
            active: true,
            updatedAt: sql`clock_timestamp()`,
          },
          setWhere: eq(sourceConnections.tenantId, options.tenantId),
        })
        .returning({ id: sourceConnections.id });
      const connectionRow = connectionRows[0];
      if (connectionRow === undefined) {
        throw new Error("Bootstrap webhook connection ID belongs to another tenant");
      }
      sourceConnectionId = connectionRow.id;
    }

    return {
      tenantId: options.tenantId,
      apiClient: mapPrincipal(clientRow),
      sourceConnectionId,
    };
  });
}

function validateBootstrapOptions(options: BootstrapOptions): void {
  if (options.tenantName.trim().length === 0) {
    throw new TypeError("tenantName must not be blank");
  }
  if (!/^[\x21-\x7e]{8,}$/.test(options.apiKey)) {
    throw new TypeError("apiKey must contain at least 8 printable ASCII characters without spaces");
  }
  const retentionDays = options.retentionDays ?? 30;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 30 || retentionDays > 3650) {
    throw new RangeError("retentionDays must be an integer between 30 and 3650");
  }
  const scopes = options.scopes ?? ["events:read", "events:write"];
  if (scopes.length === 0) {
    throw new TypeError("scopes must contain at least one scope");
  }
  if (scopes.some((scope) => !API_CLIENT_SCOPES.has(scope))) {
    throw new TypeError("scopes may contain only events:read and events:write");
  }
  if (new Set(scopes).size !== scopes.length) {
    throw new TypeError("scopes must not contain duplicates");
  }
  if (
    options.webhook !== undefined &&
    (options.webhook.secret.length < 16 || options.webhook.secret.trim().length === 0)
  ) {
    throw new TypeError("webhook secret must be at least 16 characters");
  }
}

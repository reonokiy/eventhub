import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

import { hashApiKey } from "../security/api-key.js";
import { getDatabase, type Database } from "./database.js";
import { apiClients } from "./schema.js";
import type { ApiClientPrincipal } from "./types.js";

interface ApiClientRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: string[];
  readonly expiresAt: Date | null;
}

/** Authenticates an already-hashed API key without ever loading key material. */
export async function authenticateApiKey(
  keyHash: string,
  database: Database = getDatabase(),
): Promise<ApiClientPrincipal | null> {
  if (!/^[0-9a-f]{64}$/.test(keyHash)) {
    return null;
  }

  const rows = await database
    .update(apiClients)
    .set({ lastUsedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(apiClients.keyHash, keyHash),
        isNull(apiClients.revokedAt),
        or(isNull(apiClients.expiresAt), gt(apiClients.expiresAt, sql`clock_timestamp()`)),
      ),
    )
    .returning({
      id: apiClients.id,
      tenantId: apiClients.tenantId,
      name: apiClients.name,
      keyPrefix: apiClients.keyPrefix,
      scopes: apiClients.scopes,
      expiresAt: apiClients.expiresAt,
    });
  const row = rows[0];
  return row === undefined ? null : mapPrincipal(row);
}

/**
 * Verifies that a previously authenticated credential is still active without
 * updating last_used_at. Long-lived SSE streams use this check so key rotation
 * and revocation take effect for the existing connection as well as new HTTP
 * requests.
 */
export async function verifyActiveApiKey(
  keyHash: string,
  database: Database = getDatabase(),
): Promise<ApiClientPrincipal | null> {
  if (!/^[0-9a-f]{64}$/.test(keyHash)) {
    return null;
  }

  const rows = await database
    .select({
      id: apiClients.id,
      tenantId: apiClients.tenantId,
      name: apiClients.name,
      keyPrefix: apiClients.keyPrefix,
      scopes: apiClients.scopes,
      expiresAt: apiClients.expiresAt,
    })
    .from(apiClients)
    .where(
      and(
        eq(apiClients.keyHash, keyHash),
        isNull(apiClients.revokedAt),
        or(isNull(apiClients.expiresAt), gt(apiClients.expiresAt, sql`clock_timestamp()`)),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : mapPrincipal(row);
}

export function authenticateApiKeyValue(
  apiKey: string,
  database: Database = getDatabase(),
): Promise<ApiClientPrincipal | null> {
  return authenticateApiKey(hashApiKey(apiKey), database);
}

export function mapPrincipal(row: ApiClientRow): ApiClientPrincipal {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    expiresAt: row.expiresAt,
  };
}

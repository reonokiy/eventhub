import { and, eq } from "drizzle-orm";

import { getDatabase, type Database } from "./database.js";
import { sourceConnections } from "./schema.js";
import type { SourceConnection } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getSourceConnection(
  provider: string,
  connectionId: string,
  database: Database = getDatabase(),
): Promise<SourceConnection | null> {
  if (!UUID_PATTERN.test(connectionId)) {
    return null;
  }

  const rows = await database
    .select({
      id: sourceConnections.id,
      tenantId: sourceConnections.tenantId,
      provider: sourceConnections.provider,
      name: sourceConnections.name,
      stream: sourceConnections.stream,
      signingSecret: sourceConnections.signingSecret,
      config: sourceConnections.config,
      checkpoint: sourceConnections.checkpoint,
    })
    .from(sourceConnections)
    .where(
      and(
        eq(sourceConnections.id, connectionId),
        eq(sourceConnections.provider, provider),
        eq(sourceConnections.active, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}


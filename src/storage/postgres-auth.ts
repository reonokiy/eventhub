import { authenticateApiKey, verifyActiveApiKey } from "../db/auth.js";
import { getSourceConnection } from "../db/connections.js";
import type { Database } from "../db/database.js";
import type { ApiClientAuthenticator, AuthenticatedClient } from "../http/auth.js";
import type { SourceConnection, SourceConnectionStore } from "../service/connections.js";

export class PostgresApiClientAuthenticator implements ApiClientAuthenticator {
  public constructor(private readonly database: Database) {}

  public async findActiveClientByKeyHash(
    keyHash: string,
  ): Promise<AuthenticatedClient | undefined> {
    const principal = await authenticateApiKey(keyHash, this.database);
    return toAuthenticatedClient(principal);
  }

  public async verifyActiveClientByKeyHash(
    keyHash: string,
  ): Promise<AuthenticatedClient | undefined> {
    const principal = await verifyActiveApiKey(keyHash, this.database);
    return toAuthenticatedClient(principal);
  }
}

function toAuthenticatedClient(
  principal: Awaited<ReturnType<typeof authenticateApiKey>>,
): AuthenticatedClient | undefined {
    if (principal === null) {
      return undefined;
    }
    return {
      clientId: principal.id,
      tenantId: principal.tenantId,
      name: principal.name,
      scopes: principal.scopes,
    };
}

export class PostgresSourceConnectionStore implements SourceConnectionStore {
  public constructor(private readonly database: Database) {}

  public async findActiveConnection(
    provider: string,
    connectionId: string,
  ): Promise<SourceConnection | undefined> {
    try {
      const connection = await getSourceConnection(provider, connectionId, this.database);
      if (connection === null) {
        return undefined;
      }
      return {
        id: connection.id,
        tenantId: connection.tenantId,
        provider: connection.provider,
        stream: connection.stream,
        ...(connection.signingSecret === null
          ? {}
          : { signingSecret: connection.signingSecret }),
      };
    } catch (error) {
      if (isInvalidUuidError(error)) {
        return undefined;
      }
      throw error;
    }
  }
}

function isInvalidUuidError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "22P02"
  );
}

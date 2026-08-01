import type { FastifyRequest } from "fastify";
import { hashApiKey, parseBearerToken } from "../security/api-key.js";
import { HttpError } from "./errors.js";

export interface AuthenticatedClient {
  readonly clientId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly scopes: readonly string[];
}

export interface ApiClientAuthenticator {
  findActiveClientByKeyHash(keyHash: string): Promise<AuthenticatedClient | undefined>;
  /**
   * Checks whether an already-established credential remains usable without
   * mutating its last-used timestamp. SSE uses this to invalidate a stream
   * after its key has been rotated or revoked.
   */
  verifyActiveClientByKeyHash(keyHash: string): Promise<AuthenticatedClient | undefined>;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthenticatedClient;
  }
}

export function createAuthenticator(
  repository: Pick<ApiClientAuthenticator, "findActiveClientByKeyHash">,
) {
  return async function authenticate(request: FastifyRequest): Promise<AuthenticatedClient> {
    let token: string;
    try {
      token = parseBearerToken(request.headers.authorization);
    } catch {
      throw new HttpError(401, "unauthorized", "A valid Bearer API key is required");
    }

    const client = await repository.findActiveClientByKeyHash(hashApiKey(token));
    if (client === undefined) {
      throw new HttpError(401, "unauthorized", "A valid Bearer API key is required");
    }
    request.auth = client;
    return client;
  };
}

export function requireScope(client: AuthenticatedClient, scope: string): void {
  if (!client.scopes.includes(scope)) {
    throw new HttpError(403, "forbidden", `API client requires the ${scope} scope`);
  }
}

import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  ApiClientNameConflictError,
  ApiClientNotFoundError,
  ApiClientProvisioningValidationError,
  createTenant,
  listApiClients,
  listTenants,
  provisionApiClient,
  revokeApiClient,
  rotateApiClient,
  TenantManagementValidationError,
  TenantNotFoundError,
  TenantSlugConflictError,
} from "../../db/index.js";
import type { Database } from "../../db/database.js";
import { isJsonObject } from "../../domain/json.js";
import { requireContentType } from "../content-type.js";
import { HttpError } from "../errors.js";
import { parseJsonBody } from "../raw-body.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AdminApiClientScope = "events:read" | "events:write";

export interface AdminTenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly retentionDays: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminApiClient {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly AdminApiClientScope[];
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
}

interface NewAdminApiClient extends AdminApiClient {
  readonly apiKey: string;
}

export interface AdminProvisionedApiClient extends AdminApiClient {
  /** This value is deliberately emitted only by create and rotate responses. */
  readonly apiKey: string;
}

export interface CreateAdminTenantInput {
  readonly slug: string;
  readonly name: string;
  readonly retentionDays?: number;
}

export interface CreateAdminApiClientInput {
  readonly tenantId: string;
  readonly name: string;
  readonly scopes: readonly AdminApiClientScope[];
}

export interface RotateAdminApiClientInput {
  readonly tenantId: string;
  readonly clientId: string;
}

export interface RevokeAdminApiClientInput {
  readonly tenantId: string;
  readonly clientId: string;
}

/**
 * Deliberately small repository boundary. It keeps HTTP tests independent of
 * PostgreSQL while production wiring still uses the Drizzle data layer below.
 */
export interface AdminRepository {
  createTenant(input: CreateAdminTenantInput): Promise<AdminTenant>;
  listTenants(): Promise<readonly AdminTenant[]>;
  listApiClients(tenantId: string): Promise<readonly AdminApiClient[]>;
  provisionApiClient(input: CreateAdminApiClientInput): Promise<NewAdminApiClient>;
  rotateApiClient(input: RotateAdminApiClientInput): Promise<AdminProvisionedApiClient>;
  revokeApiClient(input: RevokeAdminApiClientInput): Promise<AdminApiClient>;
}

export interface AdminRouteDependencies {
  readonly authenticateAdmin: (request: FastifyRequest) => Promise<void>;
  readonly repository: AdminRepository;
}

/** Creates the production repository without making app-client credentials administrative. */
export function createDatabaseAdminRepository(database: Database): AdminRepository {
  return {
    createTenant: (input) => createTenant(input, database),
    listTenants: () => listTenants(database),
    listApiClients: (tenantId) => listApiClients(tenantId, database),
    provisionApiClient: (input) => provisionApiClient(input, database),
    rotateApiClient: (input) => rotateApiClient(input, database),
    revokeApiClient: (input) => revokeApiClient(input, database),
  };
}

export function registerAdminRoutes(
  app: FastifyInstance,
  dependencies: AdminRouteDependencies,
): void {
  const { authenticateAdmin, repository } = dependencies;

  app.post(
    "/v1/admin/tenants",
    { onRequest: authenticateAdmin },
    async (request, reply) => {
      requireContentType(request.headers["content-type"], "application/json");
      const tenant = await executeAdminOperation(() =>
        repository.createTenant(parseCreateTenantInput(request.body)),
      );
      return reply.code(201).send(toPublicTenant(tenant));
    },
  );

  app.get(
    "/v1/admin/tenants",
    { onRequest: authenticateAdmin },
    async () => {
      const tenants = await executeAdminOperation(() => repository.listTenants());
      return { tenants: tenants.map(toPublicTenant) };
    },
  );

  app.get(
    "/v1/admin/tenants/:tenantId/api-clients",
    { onRequest: authenticateAdmin },
    async (request) => {
      const tenantId = parsePathUuid(request, "tenantId", "tenant_id");
      const clients = await executeAdminOperation(() => repository.listApiClients(tenantId));
      return { api_clients: clients.map(toPublicApiClient) };
    },
  );

  app.post(
    "/v1/admin/tenants/:tenantId/api-clients",
    { onRequest: authenticateAdmin },
    async (request, reply) => {
      requireContentType(request.headers["content-type"], "application/json");
      const tenantId = parsePathUuid(request, "tenantId", "tenant_id");
      const provisioned = await executeAdminOperation(() =>
        repository.provisionApiClient(parseCreateApiClientInput(tenantId, request.body)),
      );
      return reply.code(201).send({
        api_key: provisioned.apiKey,
        client: toPublicApiClient(provisioned),
      });
    },
  );

  app.post(
    "/v1/admin/tenants/:tenantId/api-clients/:clientId/rotate",
    { onRequest: authenticateAdmin },
    async (request) => {
      requireContentType(request.headers["content-type"], "application/json");
      assertEmptyJsonObject(request.body);
      const input = parseApiClientPath(request);
      const rotated = await executeAdminOperation(() => repository.rotateApiClient(input));
      return {
        api_key: rotated.apiKey,
        client: toPublicApiClient(rotated),
      };
    },
  );

  app.post(
    "/v1/admin/tenants/:tenantId/api-clients/:clientId/revoke",
    { onRequest: authenticateAdmin },
    async (request) => {
      requireContentType(request.headers["content-type"], "application/json");
      assertEmptyJsonObject(request.body);
      const client = await executeAdminOperation(() =>
        repository.revokeApiClient(parseApiClientPath(request)),
      );
      return { client: toPublicApiClient(client) };
    },
  );
}

function parseCreateTenantInput(body: unknown): CreateAdminTenantInput {
  const object = parseAdminJsonObject(body, ["slug", "name", "retention_days"]);
  const slug = readRequiredString(object, "slug");
  const name = readRequiredString(object, "name");
  const retentionDays = readOptionalSafeInteger(object, "retention_days");
  return {
    slug,
    name,
    ...(retentionDays === undefined ? {} : { retentionDays }),
  };
}

function parseCreateApiClientInput(
  tenantId: string,
  body: unknown,
): CreateAdminApiClientInput {
  const object = parseAdminJsonObject(body, ["name", "scopes"]);
  const name = readRequiredString(object, "name");
  const scopesValue = object.scopes;
  if (
    !Array.isArray(scopesValue) ||
    scopesValue.length === 0 ||
    !scopesValue.every(isAdminApiClientScope)
  ) {
    throw invalidAdminRequest("scopes must be an array containing events:read and/or events:write");
  }
  return { tenantId, name, scopes: scopesValue };
}

function parseApiClientPath(request: FastifyRequest): RotateAdminApiClientInput {
  return {
    tenantId: parsePathUuid(request, "tenantId", "tenant_id"),
    clientId: parsePathUuid(request, "clientId", "client_id"),
  };
}

function parsePathUuid(
  request: FastifyRequest,
  parameterName: "tenantId" | "clientId",
  publicName: "tenant_id" | "client_id",
): string {
  const parameters = request.params as Record<string, unknown>;
  const value = parameters[parameterName];
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw invalidAdminRequest(`${publicName} must be a valid UUID`);
  }
  return value;
}

function parseAdminJsonObject(
  body: unknown,
  allowedFields: readonly string[],
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseJsonBody(body);
  } catch {
    // Keep every malformed management payload under the management API's
    // stable validation code instead of leaking the generic JSON route code.
    throw invalidAdminRequest("Request body must contain valid JSON");
  }
  if (!isJsonObject(parsed)) {
    throw invalidAdminRequest("Request body must be a JSON object");
  }
  const unknownField = Object.keys(parsed).find((field) => !allowedFields.includes(field));
  if (unknownField !== undefined) {
    throw invalidAdminRequest(`Request body contains an unknown field: ${unknownField}`);
  }
  return parsed;
}

function assertEmptyJsonObject(body: unknown): void {
  parseAdminJsonObject(body, []);
}

function readRequiredString(object: Record<string, unknown>, field: string): string {
  const value = object[field];
  if (typeof value !== "string") {
    throw invalidAdminRequest(`${field} must be a string`);
  }
  return value;
}

function readOptionalSafeInteger(
  object: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = object[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidAdminRequest(`${field} must be an integer`);
  }
  return value;
}

function isAdminApiClientScope(value: unknown): value is AdminApiClientScope {
  return value === "events:read" || value === "events:write";
}

function invalidAdminRequest(message: string): HttpError {
  return new HttpError(400, "invalid_admin_request", message);
}

async function executeAdminOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    throw mapAdminRepositoryError(error);
  }
}

export function mapAdminRepositoryError(error: unknown): Error {
  if (error instanceof HttpError) {
    return error;
  }
  if (
    error instanceof TenantManagementValidationError ||
    error instanceof ApiClientProvisioningValidationError
  ) {
    return invalidAdminRequest(error.message);
  }
  if (error instanceof TenantNotFoundError) {
    return new HttpError(404, "tenant_not_found", "The requested tenant does not exist");
  }
  if (error instanceof ApiClientNotFoundError) {
    return new HttpError(404, "api_client_not_found", "The requested API client does not exist");
  }
  if (error instanceof TenantSlugConflictError) {
    return new HttpError(409, "tenant_slug_conflict", "A tenant already uses this slug");
  }
  if (error instanceof ApiClientNameConflictError) {
    return new HttpError(
      409,
      "api_client_name_conflict",
      "An API client already uses this name for the tenant",
    );
  }
  return error instanceof Error ? error : new Error("Unknown admin repository error", { cause: error });
}

function toPublicTenant(tenant: AdminTenant) {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    retention_days: tenant.retentionDays,
    created_at: tenant.createdAt.toISOString(),
    updated_at: tenant.updatedAt.toISOString(),
  };
}

function toPublicApiClient(client: AdminApiClient) {
  return {
    id: client.id,
    tenant_id: client.tenantId,
    name: client.name,
    key_prefix: client.keyPrefix,
    scopes: client.scopes,
    expires_at: dateOrNull(client.expiresAt),
    revoked_at: dateOrNull(client.revokedAt),
    created_at: client.createdAt.toISOString(),
    updated_at: client.updatedAt.toISOString(),
    last_used_at: dateOrNull(client.lastUsedAt),
  };
}

function dateOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

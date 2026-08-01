import { randomBytes } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";

import { hashApiKey } from "../security/api-key.js";
import { getDatabase, type Database } from "./database.js";
import { TenantNotFoundError } from "./events.js";
import { apiClients, tenants } from "./schema.js";

const API_KEY_PREFIX = "ehk_";
const API_KEY_RANDOM_BYTES = 32;
const API_KEY_PREFIX_LENGTH = 12;
const MAX_API_CLIENT_NAME_LENGTH = 255;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SCOPES = new Set<ApiClientScope>(["events:read", "events:write"]);

export type ApiClientScope = "events:read" | "events:write";

export interface ProvisionApiClientInput {
  readonly tenantId: string;
  readonly name: string;
  readonly scopes: readonly ApiClientScope[];
}

/**
 * Non-secret API-client metadata suitable for an operator-facing API.  Keep
 * keyHash out of this shape: the database digest is authentication material,
 * not management API output.
 */
export interface AdminApiClient {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly ApiClientScope[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

/** A safe API-client representation plus the one-time secret from creation or rotation. */
export interface ProvisionedApiClient extends AdminApiClient {
  /**
   * Secret material is intentionally returned only by this creation operation.
   * It is never read from PostgreSQL because only its SHA-256 digest is stored.
   */
  readonly apiKey: string;
}

/** Alias used by the admin API contract for create and rotate responses. */
export type AdminProvisionedApiClient = ProvisionedApiClient;

/** Alias that makes the write-once secret returned by rotation explicit. */
export type RotatedApiClient = AdminProvisionedApiClient;

export interface ApiClientManagementInput {
  readonly tenantId: string;
  readonly clientId: string;
}

export type RotateApiClientInput = ApiClientManagementInput;
export type RevokeApiClientInput = ApiClientManagementInput;

interface ValidatedProvisionApiClientInput {
  readonly tenantId: string;
  readonly name: string;
  readonly scopes: readonly ApiClientScope[];
}

export class ApiClientProvisioningValidationError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = "ApiClientProvisioningValidationError";
  }
}

export class ApiClientNameConflictError extends Error {
  public constructor(
    public readonly tenantId: string,
    public readonly clientName: string,
    options?: ErrorOptions,
  ) {
    super(`API client named ${clientName} already exists for tenant ${tenantId}`, options);
    this.name = "ApiClientNameConflictError";
  }
}

export class ApiClientNotFoundError extends Error {
  public constructor(
    public readonly tenantId: string,
    public readonly clientId: string,
  ) {
    super(`API client ${clientId} does not exist for tenant ${tenantId}`);
    this.name = "ApiClientNotFoundError";
  }
}

/** Creates a 256-bit, printable URL-safe API key suitable for a Bearer token. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(API_KEY_RANDOM_BYTES).toString("base64url")}`;
}

export function validateProvisionApiClientInput(
  input: ProvisionApiClientInput,
): ValidatedProvisionApiClientInput {
  if (!UUID_PATTERN.test(input.tenantId)) {
    throw new ApiClientProvisioningValidationError("tenantId must be a valid UUID");
  }

  const name = input.name.trim();
  if (name.length === 0 || name.length > MAX_API_CLIENT_NAME_LENGTH) {
    throw new ApiClientProvisioningValidationError(
      `name must contain between 1 and ${MAX_API_CLIENT_NAME_LENGTH} characters`,
    );
  }

  const scopes = [...input.scopes];
  if (scopes.length === 0) {
    throw new ApiClientProvisioningValidationError("scopes must contain at least one scope");
  }
  if (scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    throw new ApiClientProvisioningValidationError(
      "scopes may contain only events:read and events:write",
    );
  }
  if (new Set(scopes).size !== scopes.length) {
    throw new ApiClientProvisioningValidationError("scopes must not contain duplicates");
  }

  return { tenantId: input.tenantId, name, scopes };
}

export function validateApiClientManagementInput(
  input: ApiClientManagementInput,
): ApiClientManagementInput {
  assertUuid(input.tenantId, "tenantId");
  assertUuid(input.clientId, "clientId");
  return input;
}

/**
 * Provisions one named client for an existing tenant. The database retains only
 * a SHA-256 digest and a non-secret key prefix; callers must treat apiKey as a
 * write-once value.
 */
export async function provisionApiClient(
  input: ProvisionApiClientInput,
  database: Database = getDatabase(),
): Promise<ProvisionedApiClient> {
  const validated = validateProvisionApiClientInput(input);

  await requireTenant(validated.tenantId, database);

  const existingRows = await database
    .select({ id: apiClients.id })
    .from(apiClients)
    .where(
      and(
        eq(apiClients.tenantId, validated.tenantId),
        eq(apiClients.name, validated.name),
      ),
    )
    .limit(1);
  if (existingRows[0] !== undefined) {
    throw new ApiClientNameConflictError(validated.tenantId, validated.name);
  }

  const apiKey = generateApiKey();
  const keyPrefix = apiKey.slice(0, API_KEY_PREFIX_LENGTH);
  try {
    const rows = await database
      .insert(apiClients)
      .values({
        tenantId: validated.tenantId,
        name: validated.name,
        keyPrefix,
        keyHash: hashApiKey(apiKey),
        scopes: [...validated.scopes],
      })
      .returning({
        id: apiClients.id,
        tenantId: apiClients.tenantId,
        name: apiClients.name,
        keyPrefix: apiClients.keyPrefix,
        scopes: apiClients.scopes,
        createdAt: apiClients.createdAt,
        updatedAt: apiClients.updatedAt,
        lastUsedAt: apiClients.lastUsedAt,
        expiresAt: apiClients.expiresAt,
        revokedAt: apiClients.revokedAt,
      });
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to create API client");
    }
    return {
      ...mapAdminApiClient(row),
      apiKey,
    };
  } catch (error) {
    if (hasDatabaseError(error, "23503")) {
      throw new TenantNotFoundError(validated.tenantId);
    }
    if (hasDatabaseError(error, "23505", "api_clients_tenant_name_unique")) {
      throw new ApiClientNameConflictError(validated.tenantId, validated.name, {
        cause: error,
      });
    }
    throw error;
  }
}

/** Lists an existing tenant's API clients without exposing their key digests. */
export async function listApiClients(
  tenantId: string,
  database: Database = getDatabase(),
): Promise<readonly AdminApiClient[]> {
  assertUuid(tenantId, "tenantId");
  await requireTenant(tenantId, database);
  const rows = await database
    .select({
      id: apiClients.id,
      tenantId: apiClients.tenantId,
      name: apiClients.name,
      keyPrefix: apiClients.keyPrefix,
      scopes: apiClients.scopes,
      createdAt: apiClients.createdAt,
      updatedAt: apiClients.updatedAt,
      lastUsedAt: apiClients.lastUsedAt,
      expiresAt: apiClients.expiresAt,
      revokedAt: apiClients.revokedAt,
    })
    .from(apiClients)
    .where(eq(apiClients.tenantId, tenantId))
    .orderBy(asc(apiClients.createdAt), asc(apiClients.id));
  return rows.map(mapAdminApiClient);
}

/**
 * Replaces a tenant-scoped credential with a fresh secret.  Rotation makes a
 * revoked or expired client usable again, but preserves its identity, name,
 * and capability set.
 */
export async function rotateApiClient(
  input: RotateApiClientInput,
  database: Database = getDatabase(),
): Promise<RotatedApiClient> {
  const validated = validateApiClientManagementInput(input);
  await requireTenant(validated.tenantId, database);

  const apiKey = generateApiKey();
  const rows = await database
    .update(apiClients)
    .set({
      keyPrefix: apiKey.slice(0, API_KEY_PREFIX_LENGTH),
      keyHash: hashApiKey(apiKey),
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(apiClients.tenantId, validated.tenantId),
        eq(apiClients.id, validated.clientId),
      ),
    )
    .returning({
      id: apiClients.id,
      tenantId: apiClients.tenantId,
      name: apiClients.name,
      keyPrefix: apiClients.keyPrefix,
      scopes: apiClients.scopes,
      createdAt: apiClients.createdAt,
      updatedAt: apiClients.updatedAt,
      lastUsedAt: apiClients.lastUsedAt,
      expiresAt: apiClients.expiresAt,
      revokedAt: apiClients.revokedAt,
    });
  const row = rows[0];
  if (row === undefined) {
    throw new ApiClientNotFoundError(validated.tenantId, validated.clientId);
  }
  return { ...mapAdminApiClient(row), apiKey };
}

/** Marks a tenant-scoped credential unusable. Calling it again is idempotent. */
export async function revokeApiClient(
  input: RevokeApiClientInput,
  database: Database = getDatabase(),
): Promise<AdminApiClient> {
  const validated = validateApiClientManagementInput(input);
  await requireTenant(validated.tenantId, database);

  const rows = await database
    .update(apiClients)
    .set({
      revokedAt: sql`coalesce(${apiClients.revokedAt}, clock_timestamp())`,
      updatedAt: sql`
        case
          when ${apiClients.revokedAt} is null then clock_timestamp()
          else ${apiClients.updatedAt}
        end
      `,
    })
    .where(
      and(
        eq(apiClients.tenantId, validated.tenantId),
        eq(apiClients.id, validated.clientId),
      ),
    )
    .returning({
      id: apiClients.id,
      tenantId: apiClients.tenantId,
      name: apiClients.name,
      keyPrefix: apiClients.keyPrefix,
      scopes: apiClients.scopes,
      createdAt: apiClients.createdAt,
      updatedAt: apiClients.updatedAt,
      lastUsedAt: apiClients.lastUsedAt,
      expiresAt: apiClients.expiresAt,
      revokedAt: apiClients.revokedAt,
    });
  const row = rows[0];
  if (row === undefined) {
    throw new ApiClientNotFoundError(validated.tenantId, validated.clientId);
  }
  return mapAdminApiClient(row);
}

async function requireTenant(tenantId: string, database: Database): Promise<void> {
  const tenantRows = await database
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (tenantRows[0] === undefined) {
    throw new TenantNotFoundError(tenantId);
  }
}

function mapAdminApiClient(row: {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}): AdminApiClient {
  return {
    ...row,
    scopes: row.scopes as readonly ApiClientScope[],
  };
}

function assertUuid(value: string, name: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new ApiClientProvisioningValidationError(`${name} must be a valid UUID`);
  }
}

function hasDatabaseError(error: unknown, code: string, constraint?: string): boolean {
  let current = error;
  const seen = new Set<object>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as {
      readonly cause?: unknown;
      readonly code?: unknown;
      readonly constraint?: unknown;
    };
    if (record.code === code && (constraint === undefined || record.constraint === constraint)) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

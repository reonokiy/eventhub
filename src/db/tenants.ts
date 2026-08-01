import { asc } from "drizzle-orm";

import { getDatabase, type Database } from "./database.js";
import { tenantHeads, tenants } from "./schema.js";

const TENANT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const MAX_TENANT_SLUG_LENGTH = 63;
const MAX_TENANT_NAME_LENGTH = 255;

export interface CreateTenantInput {
  readonly slug: string;
  readonly name: string;
  readonly retentionDays?: number;
}

export interface AdminTenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly retentionDays: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ValidatedCreateTenantInput {
  readonly slug: string;
  readonly name: string;
  readonly retentionDays: number;
}

export class TenantManagementValidationError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = "TenantManagementValidationError";
  }
}

export class TenantSlugConflictError extends Error {
  public constructor(
    public readonly slug: string,
    options?: ErrorOptions,
  ) {
    super(`Tenant slug ${slug} already exists`, options);
    this.name = "TenantSlugConflictError";
  }
}

export function validateCreateTenantInput(
  input: CreateTenantInput,
): ValidatedCreateTenantInput {
  const slug = input.slug.trim();
  if (!TENANT_SLUG_PATTERN.test(slug) || slug.length > MAX_TENANT_SLUG_LENGTH) {
    throw new TenantManagementValidationError(
      `slug must be lowercase URL-safe text using letters, numbers, and hyphens up to ${MAX_TENANT_SLUG_LENGTH} characters`,
    );
  }

  const name = input.name.trim();
  if (name.length === 0 || name.length > MAX_TENANT_NAME_LENGTH) {
    throw new TenantManagementValidationError(
      `name must contain between 1 and ${MAX_TENANT_NAME_LENGTH} characters`,
    );
  }

  const retentionDays = input.retentionDays ?? MIN_RETENTION_DAYS;
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_RETENTION_DAYS ||
    retentionDays > MAX_RETENTION_DAYS
  ) {
    throw new TenantManagementValidationError(
      `retentionDays must be an integer between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`,
    );
  }

  return { slug, name, retentionDays };
}

/**
 * Creates the tenant and its event-offset head in one transaction. A tenant
 * returned by this function can immediately accept events without relying on
 * a first-write side effect to initialise tenant_heads.
 */
export async function createTenant(
  input: CreateTenantInput,
  database: Database = getDatabase(),
): Promise<AdminTenant> {
  const validated = validateCreateTenantInput(input);
  try {
    return await database.transaction(async (transaction) => {
      const rows = await transaction
        .insert(tenants)
        .values(validated)
        .returning({
          id: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          retentionDays: tenants.retentionDays,
          createdAt: tenants.createdAt,
          updatedAt: tenants.updatedAt,
        });
      const tenant = rows[0];
      if (tenant === undefined) {
        throw new Error("Failed to create tenant");
      }
      await transaction.insert(tenantHeads).values({ tenantId: tenant.id, lastOffset: 0n });
      return tenant;
    });
  } catch (error) {
    if (hasDatabaseError(error, "23505")) {
      throw new TenantSlugConflictError(validated.slug, { cause: error });
    }
    throw error;
  }
}

/** Lists safe tenant metadata in stable slug order. */
export async function listTenants(
  database: Database = getDatabase(),
): Promise<readonly AdminTenant[]> {
  return database
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      retentionDays: tenants.retentionDays,
      createdAt: tenants.createdAt,
      updatedAt: tenants.updatedAt,
    })
    .from(tenants)
    .orderBy(asc(tenants.slug));
}

function hasDatabaseError(error: unknown, code: string): boolean {
  let current = error;
  const seen = new Set<object>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as { readonly cause?: unknown; readonly code?: unknown };
    if (record.code === code) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

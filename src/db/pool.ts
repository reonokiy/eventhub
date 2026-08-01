import {
  Pool,
  type PoolConfig,
} from "pg";

let defaultPool: Pool | undefined;

export function createPool(config?: PoolConfig): Pool {
  return new Pool(config);
}

export function getPool(): Pool {
  defaultPool ??= createPool(
    process.env.DATABASE_URL === undefined
      ? undefined
      : { connectionString: process.env.DATABASE_URL },
  );
  return defaultPool;
}

export function setDefaultPool(pool: Pool): void {
  if (defaultPool !== undefined && defaultPool !== pool) {
    throw new Error("The default PostgreSQL pool is already configured");
  }
  defaultPool = pool;
}

export async function closePool(pool?: Pool): Promise<void> {
  const target = pool ?? defaultPool;
  if (target === undefined) {
    return;
  }
  if (target === defaultPool) {
    defaultPool = undefined;
  }
  await target.end();
}

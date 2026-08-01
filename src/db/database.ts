import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Client, Pool, PoolClient } from "pg";

import { getPool } from "./pool.js";
import * as schema from "./schema.js";

type NodePostgresClient = Pool | PoolClient | Client;

export type Database = NodePgDatabase<typeof schema>;

const databases = new WeakMap<Pool, Database>();

export function createDatabase(client: NodePostgresClient): Database {
  return drizzle({ client, schema });
}

export function getDatabase(pool: Pool = getPool()): Database {
  let database = databases.get(pool);
  if (database === undefined) {
    database = createDatabase(pool);
    databases.set(pool, database);
  }
  return database;
}


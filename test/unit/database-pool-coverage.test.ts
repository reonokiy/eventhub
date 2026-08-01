import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Pool } from "pg";

import {
  createDatabase,
  getDatabase,
} from "../../src/db/database.js";
import {
  closePool,
  createPool,
  getPool,
  setDefaultPool,
} from "../../src/db/pool.js";

describe("default database and pool infrastructure coverage", () => {
  it("creates, caches, replaces, and closes pools across every state", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    try {
      await closePool();

      delete process.env.DATABASE_URL;
      const environmentDefault = getPool();
      assert.equal(getPool(), environmentDefault);
      await closePool();

      const databaseUrl = "postgres://coverage:coverage@127.0.0.1:6543/coverage";
      process.env.DATABASE_URL = databaseUrl;
      const environmentConfigured = getPool();
      assert.equal(environmentConfigured.options.connectionString, databaseUrl);
      await closePool(environmentConfigured);

      const configured = createPool({ max: 3 });
      assert.equal(configured.options.max, 3);
      await closePool(configured);

      const defaultPool = createPool();
      const otherPool = createPool();
      setDefaultPool(defaultPool);
      setDefaultPool(defaultPool);
      assert.throws(
        () => setDefaultPool(otherPool),
        /default PostgreSQL pool is already configured/,
      );

      await closePool(otherPool);
      assert.equal(getPool(), defaultPool);
      await closePool(defaultPool);
      await closePool();

      const endFailure = new Error("pool end failed");
      const rejectingPool = {
        end: async () => {
          throw endFailure;
        },
      } as unknown as Pool;
      await assert.rejects(closePool(rejectingPool), endFailure);
    } finally {
      await closePool().catch(() => undefined);
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });

  it("creates Drizzle databases and caches one database per pool", async () => {
    const explicitPool = createPool();
    const defaultPool = createPool();
    try {
      const directlyCreated = createDatabase(explicitPool);
      assert.ok(directlyCreated);

      const first = getDatabase(explicitPool);
      const second = getDatabase(explicitPool);
      assert.equal(second, first);

      setDefaultPool(defaultPool);
      const implicitFirst = getDatabase();
      const implicitSecond = getDatabase();
      assert.equal(implicitSecond, implicitFirst);
      assert.notEqual(implicitFirst, first);
    } finally {
      await closePool(explicitPool);
      await closePool(defaultPool);
    }
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Pool, PoolClient } from "pg";

import { runMigrations } from "../../src/storage/migrations.js";

describe("migration runner infrastructure coverage", () => {
  it("rejects a directory with no matching migration files", async () => {
    await withMigrationDirectory(
      { "README.md": "not a migration", "migration.sql": "SELECT 1" },
      async (directory) => {
        const pool = new FakeMigrationPool(new FakeMigrationClient());
        await assert.rejects(
          runMigrations(pool.asPool(), directory),
          new RegExp(`No SQL migrations found in ${escapeRegExp(directory)}`),
        );
        assert.equal(pool.connectCalls, 0);
      },
    );
  });

  it("filters, sorts, and commits new migrations", async () => {
    await withMigrationDirectory(
      {
        "002_second.sql": "SELECT 'second';\n",
        "001-first.sql": "SELECT 'first';\n",
        "notes.txt": "ignored",
      },
      async (directory) => {
        const client = new FakeMigrationClient((query) =>
          query.includes("SELECT checksum FROM schema_migrations")
            ? queryResult([], 0)
            : queryResult(),
        );

        await runMigrations(new FakeMigrationPool(client).asPool(), directory);

        const firstIndex = client.queries.findIndex(({ text }) => text === "SELECT 'first';\n");
        const secondIndex = client.queries.findIndex(({ text }) => text === "SELECT 'second';\n");
        assert.ok(firstIndex >= 0 && secondIndex > firstIndex);
        assert.equal(client.queries.filter(({ text }) => text === "BEGIN").length, 2);
        assert.equal(client.queries.filter(({ text }) => text === "COMMIT").length, 2);
        assert.equal(client.releases, 1);
      },
    );
  });

  it("uses the default migrations directory", async () => {
    const client = new FakeMigrationClient((query) =>
      query.includes("SELECT checksum FROM schema_migrations")
        ? queryResult([], 0)
        : queryResult(),
    );

    await runMigrations(new FakeMigrationPool(client).asPool());

    assert.ok(client.queries.some(({ text }) => text.includes("CREATE TABLE IF NOT EXISTS tenants")));
    assert.equal(client.releases, 1);
  });

  it("skips an already applied migration with the same checksum", async () => {
    const migration = "SELECT 'already-applied';\n";
    const checksum = createHash("sha256").update(migration, "utf8").digest("hex");
    await withMigrationDirectory({ "001_applied.sql": migration }, async (directory) => {
      const client = new FakeMigrationClient((query) =>
        query.includes("SELECT checksum FROM schema_migrations")
          ? queryResult([{ checksum }], 1)
          : queryResult(),
      );

      await runMigrations(new FakeMigrationPool(client).asPool(), directory);

      assert.equal(client.queries.some(({ text }) => text === "BEGIN"), false);
      assert.equal(client.queries.some(({ text }) => text === migration), false);
      assert.equal(client.releases, 1);
    });
  });

  it("rejects a modified applied migration and ignores an unlock failure", async () => {
    await withMigrationDirectory({ "001_changed.sql": "SELECT 'changed';\n" }, async (directory) => {
      const unlockFailure = new Error("unlock failed");
      const client = new FakeMigrationClient((query) => {
        if (query.includes("SELECT checksum FROM schema_migrations")) {
          return queryResult([{ checksum: "wrong-checksum" }], 1);
        }
        if (query.includes("pg_advisory_unlock")) {
          throw unlockFailure;
        }
        return queryResult();
      });

      await assert.rejects(
        runMigrations(new FakeMigrationPool(client).asPool(), directory),
        /Applied migration 001_changed\.sql has been modified/,
      );
      assert.equal(client.releases, 1);
    });
  });

  it("rolls a migration back when its SQL fails", async () => {
    const migration = "SELECT broken_migration;\n";
    await withMigrationDirectory({ "001_broken.sql": migration }, async (directory) => {
      const failure = new Error("migration statement failed");
      const client = new FakeMigrationClient((query) => {
        if (query.includes("SELECT checksum FROM schema_migrations")) {
          return queryResult([], 0);
        }
        if (query === migration) {
          throw failure;
        }
        return queryResult();
      });

      await assert.rejects(runMigrations(new FakeMigrationPool(client).asPool(), directory), failure);
      assert.equal(client.queries.some(({ text }) => text === "ROLLBACK"), true);
      assert.equal(client.releases, 1);
    });
  });

  it("unlocks and releases when lock acquisition fails", async () => {
    await withMigrationDirectory({ "001_one.sql": "SELECT 1;\n" }, async (directory) => {
      const failure = new Error("lock failed");
      const client = new FakeMigrationClient((query) => {
        if (query.includes("pg_advisory_lock")) {
          throw failure;
        }
        return queryResult();
      });

      await assert.rejects(runMigrations(new FakeMigrationPool(client).asPool(), directory), failure);
      assert.equal(client.queries.some(({ text }) => text.includes("pg_advisory_unlock")), true);
      assert.equal(client.releases, 1);
    });
  });

  it("propagates a pool connection failure", async () => {
    await withMigrationDirectory({ "001_one.sql": "SELECT 1;\n" }, async (directory) => {
      const failure = new Error("pool unavailable");
      const pool = new FakeMigrationPool(failure);
      await assert.rejects(runMigrations(pool.asPool(), directory), failure);
      assert.equal(pool.connectCalls, 1);
    });
  });
});

interface FakeQueryResult {
  readonly rows: Array<Record<string, unknown>>;
  readonly rowCount: number;
}

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

type QueryHandler = (
  query: string,
  values: readonly unknown[] | undefined,
) => FakeQueryResult | Promise<FakeQueryResult>;

class FakeMigrationClient {
  readonly #handler: QueryHandler;
  public readonly queries: RecordedQuery[] = [];
  public releases = 0;

  public constructor(handler: QueryHandler = () => queryResult()) {
    this.#handler = handler;
  }

  public async query(
    text: string,
    values?: readonly unknown[],
  ): Promise<FakeQueryResult> {
    this.queries.push({ text, values });
    return this.#handler(text, values);
  }

  public release(): void {
    this.releases += 1;
  }

  public asPoolClient(): PoolClient {
    return this as unknown as PoolClient;
  }
}

class FakeMigrationPool {
  readonly #clientOrError: FakeMigrationClient | Error;
  public connectCalls = 0;

  public constructor(clientOrError: FakeMigrationClient | Error) {
    this.#clientOrError = clientOrError;
  }

  public async connect(): Promise<PoolClient> {
    this.connectCalls += 1;
    if (this.#clientOrError instanceof Error) {
      throw this.#clientOrError;
    }
    return this.#clientOrError.asPoolClient();
  }

  public asPool(): Pool {
    return this as unknown as Pool;
  }
}

function queryResult(
  rows: Array<Record<string, unknown>> = [],
  rowCount = rows.length,
): FakeQueryResult {
  return { rows, rowCount };
}

async function withMigrationDirectory(
  files: Readonly<Record<string, string>>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "eventhub-migrations-"));
  try {
    for (const [filename, contents] of Object.entries(files)) {
      await writeFile(path.join(directory, filename), contents, "utf8");
    }
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import { lte, sql } from "drizzle-orm";

import type { Database } from "../db/database.js";
import { publishIdempotencyKeys } from "../db/schema.js";

export interface RetentionLogger {
  info(properties: object, message: string): void;
  error(properties: object, message: string): void;
}

interface DeletedCountRow extends Record<string, unknown> {
  readonly deletedCount: string;
}

export class RetentionWorker {
  readonly #database: Database;
  readonly #logger: RetentionLogger;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;

  public constructor(database: Database, logger: RetentionLogger, intervalMs = 3_600_000) {
    this.#database = database;
    this.#logger = logger;
    this.#intervalMs = intervalMs;
  }

  public start(): void {
    if (this.#timer !== undefined || this.#running !== undefined) {
      return;
    }
    this.#stopped = false;
    this.#runAndReschedule();
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#running;
  }

  async #deleteBatch(): Promise<number> {
    // ctid and DELETE ... USING are PostgreSQL-specific maintenance primitives,
    // so this bounded cleanup query intentionally stays as controlled SQL.
    const result = await this.#database.execute<DeletedCountRow>(sql`
      WITH expired AS (
        SELECT e.ctid
        FROM events AS e
        INNER JOIN tenants AS t ON t.id = e.tenant_id
        WHERE e.received_at < clock_timestamp() - make_interval(days => t.retention_days)
        ORDER BY e.received_at
        LIMIT 1000
      ), deleted AS (
        DELETE FROM events AS e
        USING expired
        WHERE e.ctid = expired.ctid
        RETURNING 1
      )
      SELECT count(*)::text AS "deletedCount" FROM deleted
    `);
    return Number(result.rows[0]!.deletedCount);
  }

  async #run(): Promise<void> {
    let total = 0;
    for (let batch = 0; batch < 100; batch += 1) {
      const deleted = await this.#deleteBatch();
      total += deleted;
      if (deleted < 1000) {
        break;
      }
    }
    await this.#database
      .delete(publishIdempotencyKeys)
      .where(lte(publishIdempotencyKeys.expiresAt, sql`clock_timestamp()`));
    if (total > 0) {
      this.#logger.info({ deletedEvents: total }, "Deleted events outside tenant retention windows");
    }
  }

  #runAndReschedule(): void {
    this.#running = this.#run()
      .catch((error: unknown) => {
        this.#logger.error({ err: error }, "Event retention cleanup failed");
      })
      .finally(() => {
        this.#running = undefined;
        if (this.#stopped) {
          return;
        }
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          this.#runAndReschedule();
        }, this.#intervalMs);
        this.#timer.unref();
      });
  }
}

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { Database } from "../../db/database.js";

export function registerHealthRoutes(app: FastifyInstance, database: Database): void {
  app.get("/", async () => ({
    service: "eventhub",
    version: "0.1.0",
    specification: "spec/",
  }));

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await database.execute(sql`SELECT 1`);
      return { status: "ok" };
    } catch {
      reply.code(503);
      return { status: "unavailable" };
    }
  });
}


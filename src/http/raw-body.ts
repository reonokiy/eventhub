import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function registerJsonBodyParser(app: FastifyInstance, bodyLimit: number): void {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    ["application/json", "application/cloudevents+json"],
    { parseAs: "buffer", bodyLimit },
    (request: FastifyRequest, body: Buffer, done) => {
      request.rawBody = body;
      done(null, body);
    },
  );
}

export function parseJsonBody(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) {
    throw new SyntaxError("Request body was not parsed as JSON bytes");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new SyntaxError("Request body must be valid UTF-8");
  }
  return JSON.parse(text) as unknown;
}

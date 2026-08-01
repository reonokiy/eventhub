import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function generateRequestId(request: IncomingMessage): string {
  const header = request.headers["x-request-id"];
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : `req_${randomUUID()}`;
}

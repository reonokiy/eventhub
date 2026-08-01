import { createHash } from "node:crypto";

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function parseBearerToken(authorization: string | undefined): string {
  if (authorization === undefined) {
    throw new AuthenticationHeaderError("Authorization header is required");
  }
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (match?.[1] === undefined || match[1].length < 8) {
    throw new AuthenticationHeaderError("Authorization must use a valid Bearer token");
  }
  return match[1];
}

export class AuthenticationHeaderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AuthenticationHeaderError";
  }
}

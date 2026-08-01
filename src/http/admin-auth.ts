import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";

import { parseBearerToken } from "../security/api-key.js";
import { HttpError } from "./errors.js";

/**
 * Compares API-key material without exposing a short-circuiting string
 * comparison. Both SHA-256 digests have the same fixed length, which also
 * avoids timingSafeEqual's length precondition becoming observable.
 */
export function constantTimeApiKeyEquals(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Authenticates the operator-only admin API. Application API keys must never
 * grant access here, even if they have every event scope.
 */
export function createAdminAuthenticator(adminApiKey: string) {
  return async function authenticateAdmin(request: FastifyRequest): Promise<void> {
    let provided = "";
    try {
      provided = parseBearerToken(request.headers.authorization);
    } catch {
      // Still perform the fixed-length comparison so malformed and unknown
      // credentials take the same authentication path.
    }

    if (!constantTimeApiKeyEquals(provided, adminApiKey)) {
      throw new HttpError(
        401,
        "admin_unauthorized",
        "A valid administrator Bearer API key is required",
      );
    }
  };
}

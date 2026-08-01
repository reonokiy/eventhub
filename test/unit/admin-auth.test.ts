import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FastifyRequest } from "fastify";

import {
  constantTimeApiKeyEquals,
  createAdminAuthenticator,
} from "../../src/http/admin-auth.js";
import { HttpError } from "../../src/http/errors.js";

describe("admin HTTP authentication", () => {
  it("compares same and different credentials through fixed-length digests", () => {
    assert.equal(constantTimeApiKeyEquals("admin-api-key", "admin-api-key"), true);
    assert.equal(constantTimeApiKeyEquals("application-api-key", "admin-api-key"), false);
  });

  it("accepts only the configured administrator Bearer key", async () => {
    const authenticate = createAdminAuthenticator("admin-api-key");

    await assert.doesNotReject(() => authenticate(requestWithAuthorization("Bearer admin-api-key")));
    await assert.rejects(
      () => authenticate(requestWithAuthorization("Bearer application-api-key")),
      isAdminUnauthorized,
    );
  });

  it("returns the same problem for absent and malformed credentials", async () => {
    const authenticate = createAdminAuthenticator("admin-api-key");

    await assert.rejects(() => authenticate(requestWithAuthorization(undefined)), isAdminUnauthorized);
    await assert.rejects(
      () => authenticate(requestWithAuthorization("Basic admin-api-key")),
      isAdminUnauthorized,
    );
  });
});

function requestWithAuthorization(authorization: string | undefined): FastifyRequest {
  return {
    headers: authorization === undefined ? {} : { authorization },
  } as FastifyRequest;
}

function isAdminUnauthorized(error: unknown): boolean {
  assert.ok(error instanceof HttpError);
  assert.equal(error.statusCode, 401);
  assert.equal(error.code, "admin_unauthorized");
  assert.equal(error.message, "A valid administrator Bearer API key is required");
  return true;
}

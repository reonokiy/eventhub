import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FastifyRequest } from "fastify";

import {
  createAuthenticator,
  requireScope,
  type AuthenticatedClient,
} from "../../src/http/auth.js";
import { HttpError } from "../../src/http/errors.js";

const CLIENT: AuthenticatedClient = {
  clientId: "client-1",
  tenantId: "tenant-1",
  name: "test client",
  scopes: ["events:read"],
};

describe("HTTP authentication", () => {
  it("hashes a Bearer key, loads its active client, and attaches auth to the request", async () => {
    let receivedHash: string | undefined;
    const authenticate = createAuthenticator({
      async findActiveClientByKeyHash(keyHash) {
        receivedHash = keyHash;
        return CLIENT;
      },
    });
    const request = requestWithAuthorization("Bearer test-api-key");

    assert.equal(await authenticate(request), CLIENT);
    assert.equal(request.auth, CLIENT);
    assert.equal(
      receivedHash,
      "4c806362b613f7496abf284146efd31da90e4b16169fe001841ca17290f427c4",
    );
  });

  it("maps malformed and unknown API keys to the same 401 response", async () => {
    let repositoryCalls = 0;
    const authenticate = createAuthenticator({
      async findActiveClientByKeyHash() {
        repositoryCalls += 1;
        return undefined;
      },
    });

    await assert.rejects(() => authenticate(requestWithAuthorization(undefined)), isUnauthorized);
    assert.equal(repositoryCalls, 0);

    await assert.rejects(
      () => authenticate(requestWithAuthorization("Bearer unknown-key")),
      isUnauthorized,
    );
    assert.equal(repositoryCalls, 1);
  });

  it("enforces exact API client scopes", () => {
    assert.doesNotThrow(() => requireScope(CLIENT, "events:read"));
    assert.throws(
      () => requireScope(CLIENT, "events:write"),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.statusCode, 403);
        assert.equal(error.code, "forbidden");
        assert.match(error.message, /events:write/);
        return true;
      },
    );
  });
});

function requestWithAuthorization(authorization: string | undefined): FastifyRequest {
  return {
    headers: authorization === undefined ? {} : { authorization },
  } as FastifyRequest;
}

function isUnauthorized(error: unknown): boolean {
  assert.ok(error instanceof HttpError);
  assert.equal(error.statusCode, 401);
  assert.equal(error.code, "unauthorized");
  assert.equal(error.message, "A valid Bearer API key is required");
  return true;
}

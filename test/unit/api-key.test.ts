import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AuthenticationHeaderError,
  hashApiKey,
  parseBearerToken,
} from "../../src/security/api-key.js";

describe("API key helpers", () => {
  it("hashes API keys as stable lower-case SHA-256 hex", () => {
    assert.equal(
      hashApiKey("dev-api-key-change-me"),
      "57888d36c4bb8679dc293f271f58b485e8485828a3ca1911187ddcb804306683",
    );
    assert.equal(hashApiKey("dev-api-key-change-me").length, 64);
    assert.notEqual(hashApiKey("dev-api-key-change-me"), hashApiKey("dev-api-key-change-me "));
  });

  it("parses a case-insensitive Bearer authorization scheme", () => {
    assert.equal(parseBearerToken("Bearer abcdefgh"), "abcdefgh");
    assert.equal(parseBearerToken("bearer token-with-punctuation_42"), "token-with-punctuation_42");
  });

  it("rejects missing, malformed, short, and whitespace-containing tokens", () => {
    const invalid = [
      undefined,
      "",
      "Basic abcdefgh",
      "Bearer short",
      "Bearer token with spaces",
      "Bearer abcdefgh ",
    ];

    for (const authorization of invalid) {
      assert.throws(() => parseBearerToken(authorization), AuthenticationHeaderError);
    }
  });
});

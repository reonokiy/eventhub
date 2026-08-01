import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { requireContentType } from "../../src/http/content-type.js";
import { HttpError } from "../../src/http/errors.js";

describe("HTTP content type validation", () => {
  it("matches media types case-insensitively and ignores parameters", () => {
    assert.doesNotThrow(() => requireContentType("application/cloudevents+json", "application/cloudevents+json"));
    assert.doesNotThrow(() =>
      requireContentType(
        "Application/CloudEvents+JSON; charset=utf-8",
        "application/cloudevents+json",
      ),
    );
  });

  it("rejects an absent or different media type with 415", () => {
    for (const actual of [undefined, "application/json", "text/plain"]) {
      assert.throws(
        () => requireContentType(actual, "application/cloudevents+json"),
        (error: unknown) => {
          assert.ok(error instanceof HttpError);
          assert.equal(error.statusCode, 415);
          assert.equal(error.code, "unsupported_media_type");
          return true;
        },
      );
    }
  });
});

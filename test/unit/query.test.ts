import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { firstHeader, parseLimit } from "../../src/http/query.js";
import { HttpError } from "../../src/http/errors.js";

describe("HTTP query helpers", () => {
  it("uses the fallback for an omitted limit", () => {
    assert.equal(parseLimit(undefined), 100);
    assert.equal(parseLimit(undefined, 25), 25);
  });

  it("parses integer string and number limits at both boundaries", () => {
    assert.equal(parseLimit("1"), 1);
    assert.equal(parseLimit(1), 1);
    assert.equal(parseLimit("1000"), 1000);
    assert.equal(parseLimit("12", 100, 25), 12);
  });

  it("rejects values outside the configured range and non-integers", () => {
    const invalid = ["0", 0, "1001", 1001, "-1", "1.5", Number.NaN, true, {}, []];

    for (const value of invalid) {
      assert.throws(
        () => parseLimit(value),
        (error: unknown) => {
          assert.ok(error instanceof HttpError);
          assert.equal(error.statusCode, 400);
          assert.equal(error.code, "invalid_limit");
          return true;
        },
      );
    }
  });

  it("returns the first value of a repeated HTTP header", () => {
    assert.equal(firstHeader(undefined), undefined);
    assert.equal(firstHeader("one"), "one");
    assert.equal(firstHeader(["one", "two"]), "one");
    assert.equal(firstHeader([]), undefined);
  });
});

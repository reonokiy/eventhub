import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CursorValidationError,
  formatCursor,
  INITIAL_CURSOR,
  MAX_CURSOR,
  parseCursor,
} from "../../src/domain/cursor.js";

describe("event cursors", () => {
  it("treats omitted cursors as absent", () => {
    assert.equal(parseCursor(undefined), undefined);
    assert.equal(parseCursor(null), undefined);
    assert.equal(parseCursor(""), undefined);
  });

  it("parses zero and the PostgreSQL signed bigint maximum without losing precision", () => {
    assert.equal(INITIAL_CURSOR, 0n);
    assert.equal(parseCursor("0"), 0n);
    assert.equal(parseCursor(42), 42n);
    assert.equal(parseCursor("9223372036854775807"), MAX_CURSOR);
  });

  it("rejects negative, fractional, ambiguous, and non-scalar cursors", () => {
    const invalid = [
      "-1",
      "1.5",
      "01",
      "+1",
      " 1",
      "1 ",
      "1e3",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "9223372036854775808",
      "18446744073709551616000",
      true,
      {},
      [],
    ];

    for (const value of invalid) {
      assert.throws(() => parseCursor(value), CursorValidationError, `expected ${String(value)} to fail`);
    }
  });

  it("names the source field in validation errors", () => {
    assert.throws(
      () => parseCursor("invalid", "Last-Event-ID"),
      (error: unknown) => {
        assert.ok(error instanceof CursorValidationError);
        assert.match(error.message, /Last-Event-ID/);
        return true;
      },
    );
  });

  it("formats supported cursor representations as decimal strings", () => {
    assert.equal(formatCursor(0n), "0");
    assert.equal(formatCursor(1042n), "1042");
    assert.equal(formatCursor("9223372036854775807"), "9223372036854775807");
  });
});

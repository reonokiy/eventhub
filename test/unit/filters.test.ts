import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EventFilterValidationError,
  parseEventFilters,
} from "../../src/domain/filters.js";

describe("event filters", () => {
  it("extracts supported exact-match filters", () => {
    assert.deepEqual(
      parseEventFilters({
        stream: "engineering",
        type: "com.github.issue.opened.v1",
        source: "urn:eventhub:github:connection-42",
        ignored: "not part of the query contract",
      }),
      {
        stream: "engineering",
        type: "com.github.issue.opened.v1",
        source: "urn:eventhub:github:connection-42",
      },
    );
  });

  it("preserves repeated query parameters as OR filter values", () => {
    assert.deepEqual(
      parseEventFilters({
        stream: ["engineering", "operations"],
        type: ["com.example.opened.v1", "com.example.closed.v1"],
        source: ["urn:test:one", "urn:test:two"],
      }),
      {
        stream: ["engineering", "operations"],
        type: ["com.example.opened.v1", "com.example.closed.v1"],
        source: ["urn:test:one", "urn:test:two"],
      },
    );
  });

  it("returns no filters for absent or non-object query input", () => {
    for (const input of [undefined, null, [], "engineering", 42]) {
      assert.deepEqual(parseEventFilters(input), {});
    }
    assert.deepEqual(parseEventFilters({}), {});
  });

  it("rejects empty, non-string, and overlong filter values", () => {
    const invalidQueries = [
      { stream: "" },
      { stream: "   " },
      { type: 42 },
      { source: [] },
      { source: ["urn:test", 42] },
      { stream: Array.from({ length: 51 }, (_, index) => `stream-${index}`) },
      { type: "x".repeat(513) },
    ];

    for (const query of invalidQueries) {
      assert.throws(() => parseEventFilters(query), EventFilterValidationError);
    }
  });

  it("accepts the documented maximum filter length", () => {
    const value = "x".repeat(512);
    assert.deepEqual(parseEventFilters({ type: value }), { type: value });
  });
});

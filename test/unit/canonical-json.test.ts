import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalJson,
  canonicalJsonSha256,
} from "../../src/domain/canonical-json.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively while retaining array order", () => {
    assert.equal(
      canonicalJson({
        z: true,
        a: { second: 2, first: 1 },
        items: [{ z: 2, a: 1 }, null, "text"],
      }),
      '{"a":{"first":1,"second":2},"items":[{"a":1,"z":2},null,"text"],"z":true}',
    );
  });

  it("produces the same hash for semantically identical object key order", () => {
    const first = canonicalJsonSha256({ b: 2, a: { d: 4, c: 3 } });
    const second = canonicalJsonSha256({ a: { c: 3, d: 4 }, b: 2 });

    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
  });

  it("orders property names by UTF-16 code units instead of the host locale", () => {
    assert.equal(canonicalJson({ "\ue000": 1, "😀": 2 }), '{"😀":2,"":1}');
  });

  it("preserves JSON escaping and normalizes negative zero like JSON.stringify", () => {
    assert.equal(canonicalJson({ text: "line\n\"quoted\"", value: -0 }), '{"text":"line\\n\\"quoted\\"","value":0}');
  });

  it("rejects non-finite numbers at any depth", () => {
    assert.throws(() => canonicalJson(Number.NaN), TypeError);
    assert.throws(() => canonicalJson({ nested: [Number.POSITIVE_INFINITY] }), TypeError);
  });
});

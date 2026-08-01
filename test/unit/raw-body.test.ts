import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseJsonBody } from "../../src/http/raw-body.js";

describe("raw JSON body", () => {
  it("parses valid UTF-8 JSON bytes", () => {
    assert.deepEqual(parseJsonBody(Buffer.from('{"message":"你好"}', "utf8")), {
      message: "你好",
    });
  });

  it("rejects malformed UTF-8 instead of silently inserting replacement characters", () => {
    const malformed = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
    assert.throws(() => parseJsonBody(malformed), SyntaxError);
  });
});

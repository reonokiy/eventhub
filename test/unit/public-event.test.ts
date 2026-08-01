import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toPublicCloudEvent } from "../../src/service/public-event.js";

describe("public event representation", () => {
  it("adds durable stream, offset, and receive time extensions", () => {
    const receivedAt = new Date("2026-08-01T13:20:00.123Z");
    const result = toPublicCloudEvent({
      tenantId: "tenant-1",
      offset: 18_446_744_073_709_551_616n,
      stream: "engineering",
      receivedAt,
      event: {
        specversion: "1.0",
        id: "event-1",
        source: "urn:test",
        type: "com.example.test.v1",
        datacontenttype: "application/json",
        data: { ok: true },
      },
    });

    assert.deepEqual(result, {
      specversion: "1.0",
      id: "event-1",
      source: "urn:test",
      type: "com.example.test.v1",
      datacontenttype: "application/json",
      data: { ok: true },
      eventhubstream: "engineering",
      eventhuboffset: "18446744073709551616",
      eventhubreceivedat: "2026-08-01T13:20:00.123Z",
    });
  });
});

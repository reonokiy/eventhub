import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createWebhookSignature,
  verifyWebhookSignature,
  WebhookSignatureError,
} from "../../src/security/webhook-signature.js";

const SECRET = "test-secret";
const TIMESTAMP = "1785590400";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000007";
const BODY = Buffer.from('{"hello":"world"}', "utf8");
const NOW = new Date(Number(TIMESTAMP) * 1000);
const SIGNATURE = createWebhookSignature(SECRET, TIMESTAMP, CONNECTION_ID, BODY);

describe("webhook HMAC signatures", () => {
  it("creates a deterministic HMAC over timestamp, connection, and exact raw body", () => {
    assert.match(SIGNATURE, /^v1=[0-9a-f]{64}$/);
    assert.equal(createWebhookSignature(SECRET, TIMESTAMP, CONNECTION_ID, BODY), SIGNATURE);
  });

  it("accepts a valid signature within the clock-skew window", () => {
    assert.doesNotThrow(() =>
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestamp: TIMESTAMP,
        signature: SIGNATURE,
        connectionId: CONNECTION_ID,
        maximumClockSkewSeconds: 300,
        now: NOW,
      }),
    );

    assert.doesNotThrow(() =>
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestamp: TIMESTAMP,
        signature: SIGNATURE,
        connectionId: CONNECTION_ID,
        maximumClockSkewSeconds: 300,
        now: new Date(NOW.getTime() + 300_000),
      }),
    );
  });

  it("rejects a signature if any authenticated byte changes", () => {
    const changes = [
      { secret: "other-secret", rawBody: BODY, timestamp: TIMESTAMP, connectionId: CONNECTION_ID },
      { secret: SECRET, rawBody: Buffer.from('{ "hello":"world"}'), timestamp: TIMESTAMP, connectionId: CONNECTION_ID },
      { secret: SECRET, rawBody: BODY, timestamp: String(Number(TIMESTAMP) + 1), connectionId: CONNECTION_ID },
      { secret: SECRET, rawBody: BODY, timestamp: TIMESTAMP, connectionId: "00000000-0000-4000-8000-000000000008" },
    ];

    for (const change of changes) {
      assert.throws(
        () =>
          verifyWebhookSignature({
            ...change,
            signature: SIGNATURE,
            maximumClockSkewSeconds: 300,
            now: NOW,
          }),
        WebhookSignatureError,
      );
    }
  });

  it("rejects missing and malformed timestamp headers", () => {
    for (const timestamp of [undefined, "", "-1", "1.5", "not-a-time", "9".repeat(32)]) {
      assert.throws(
        () =>
          verifyWebhookSignature({
            secret: SECRET,
            rawBody: BODY,
            timestamp,
            signature: SIGNATURE,
            connectionId: CONNECTION_ID,
            maximumClockSkewSeconds: 300,
            now: NOW,
          }),
        WebhookSignatureError,
      );
    }
  });

  it("rejects stale and future timestamps outside the configured window", () => {
    for (const deltaSeconds of [-301, 301]) {
      assert.throws(
        () =>
          verifyWebhookSignature({
            secret: SECRET,
            rawBody: BODY,
            timestamp: TIMESTAMP,
            signature: SIGNATURE,
            connectionId: CONNECTION_ID,
            maximumClockSkewSeconds: 300,
            now: new Date(NOW.getTime() + deltaSeconds * 1000),
          }),
        WebhookSignatureError,
      );
    }
  });

  it("rejects absent and non-canonical signature headers", () => {
    for (const signature of [
      undefined,
      "",
      SIGNATURE.slice("v1=".length),
      SIGNATURE.toUpperCase(),
      "sha1=" + "a".repeat(64),
      "v1=" + "g".repeat(64),
      "v1=" + "a".repeat(63),
    ]) {
      assert.throws(
        () =>
          verifyWebhookSignature({
            secret: SECRET,
            rawBody: BODY,
            timestamp: TIMESTAMP,
            signature,
            connectionId: CONNECTION_ID,
            maximumClockSkewSeconds: 300,
            now: NOW,
          }),
        WebhookSignatureError,
      );
    }
  });
});

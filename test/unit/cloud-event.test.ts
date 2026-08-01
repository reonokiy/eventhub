import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertCloudEvent,
  assertPublishableCloudEvent,
  CloudEventValidationError,
  validateCloudEvent,
} from "../../src/domain/cloud-event.js";

describe("CloudEvent validation", () => {
  it("accepts a CloudEvents 1.0 JSON event and preserves extensions", () => {
    const input = {
      specversion: "1.0",
      id: "github-delivery-42",
      source: "urn:eventhub:github:connection-1",
      type: "com.github.issue.opened.v1",
      subject: "repos/acme/api/issues/18",
      time: "2026-08-01T13:20:00.123Z",
      datacontenttype: "application/json",
      dataschema: "https://example.com/schemas/github-issue-v1.json",
      traceid: "trace-42",
      attempt: 2,
      replay: false,
      data: {
        issue: 18,
        labels: ["bug", "customer"],
        assignee: null,
      },
    } as const;

    const result = validateCloudEvent(input);

    assert.equal(result.success, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.event, input);
    assert.equal(assertCloudEvent(input), input);
  });

  it("rejects values that are not JSON objects", () => {
    for (const input of [null, [], "event", 42, true]) {
      assert.deepEqual(validateCloudEvent(input), {
        success: false,
        errors: ["event must be a JSON object"],
      });
    }
  });

  it("requires the CloudEvents version, id, source, and type", () => {
    const result = validateCloudEvent({
      specversion: "0.3",
      id: " ",
      source: 42,
    });

    assert.equal(result.success, false);
    assert.deepEqual(result.errors, [
      "specversion must be 1.0",
      "id must be a non-empty string of at most 255 characters",
      "source must be a non-empty string of at most 512 characters",
      "type must be a non-empty string of at most 255 characters",
      "datacontenttype must be a non-empty string of at most 255 characters",
      "data is required",
    ]);
  });

  it("validates RFC 3339 time and an absolute dataschema URI", () => {
    const base = {
      specversion: "1.0",
      id: "event-1",
      source: "urn:test",
      type: "com.example.test",
      datacontenttype: "application/json",
      data: null,
    };

    assert.equal(
      validateCloudEvent({ ...base, time: "2026-08-01 13:20:00" }).success,
      false,
    );
    assert.equal(validateCloudEvent({ ...base, time: 123 }).success, false);
    assert.equal(validateCloudEvent({ ...base, time: "2026-02-30T00:00:00Z" }).success, false);
    assert.equal(validateCloudEvent({ ...base, time: "2024-02-29T23:59:59Z" }).success, true);
    assert.equal(validateCloudEvent({ ...base, time: "2000-02-29T23:59:59Z" }).success, true);
    assert.equal(validateCloudEvent({ ...base, time: "1900-02-29T23:59:59Z" }).success, false);
    assert.equal(validateCloudEvent({ ...base, time: "2026-04-30T23:59:59Z" }).success, true);
    assert.equal(validateCloudEvent({ ...base, time: "2026-04-31T23:59:59Z" }).success, false);
    assert.equal(validateCloudEvent({ ...base, dataschema: "/relative/schema" }).success, false);
    assert.equal(
      validateCloudEvent({ ...base, time: "2026-08-01T15:20:00+02:00" }).success,
      true,
    );
  });

  it("validates URI references, JSON content types, and optional strings", () => {
    const base = {
      specversion: "1.0",
      id: "event-1",
      source: "urn:test",
      type: "com.example.test",
      datacontenttype: "application/json",
      data: null,
    };

    assert.ok(
      validateCloudEvent({ ...base, source: "http://[" }).errors.includes(
        "source must be a valid URI-reference",
      ),
    );
    assert.ok(
      validateCloudEvent({ ...base, datacontenttype: "text/plain" }).errors.includes(
        "datacontenttype must be application/json with an optional UTF-8 charset",
      ),
    );
    assert.equal(
      validateCloudEvent({
        ...base,
        datacontenttype: "Application/JSON; charset=UTF-8",
      }).success,
      true,
    );
    for (const subject of ["", 42, "x".repeat(1025), "\ud800", "line\nbreak"]) {
      assert.ok(
        validateCloudEvent({ ...base, subject }).errors.some((error) =>
          error.startsWith("subject must be a non-empty string"),
        ),
      );
    }
  });

  it("allows only scalar, lower-case extension attributes of at most 20 characters", () => {
    const base = {
      specversion: "1.0",
      id: "event-1",
      source: "urn:test",
      type: "com.example.test",
      datacontenttype: "application/json",
      data: null,
    };

    const result = validateCloudEvent({
      ...base,
      "not-valid": "value",
      WayTooLongExtensionName: "value",
      nestedextension: { nested: true },
      invalidnumber: Number.NaN,
    });

    assert.equal(result.success, false);
    assert.ok(result.errors.some((error) => error.includes("extension attribute not-valid")));
    assert.ok(
      result.errors.some((error) => error.includes("extension attribute WayTooLongExtensionName")),
    );
    assert.ok(
      result.errors.some((error) => error.includes("extension attribute nestedextension")),
    );
    assert.ok(result.errors.some((error) => error.includes("extension attribute invalidnumber")));
  });

  it("rejects values that cannot be represented as JSON data", () => {
    const base = {
      specversion: "1.0",
      id: "event-1",
      source: "urn:test",
      type: "com.example.test",
      datacontenttype: "application/json",
    };

    for (const data of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      { value: undefined },
      { value: "\u0000" },
      { value: "\ud800" },
      { "\udc00": "invalid key" },
    ]) {
      const input = data === undefined ? { ...base, data: () => undefined } : { ...base, data };
      const result = validateCloudEvent(input);
      assert.equal(result.success, false);
      assert.ok(result.errors.includes("data must be valid JSON"));
    }
    assert.equal(validateCloudEvent({ ...base, data: { emoji: "😀" } }).success, true);
  });

  it("assertCloudEvent exposes all validation errors", () => {
    assert.throws(
      () => assertCloudEvent({ specversion: "1.0" }),
      (error: unknown) => {
        assert.ok(error instanceof CloudEventValidationError);
        assert.equal(error.name, "CloudEventValidationError");
        assert.ok(
          error.validationErrors.includes(
            "id must be a non-empty string of at most 255 characters",
          ),
        );
        assert.ok(
          error.validationErrors.includes(
            "source must be a non-empty string of at most 512 characters",
          ),
        );
        assert.ok(
          error.validationErrors.includes(
            "type must be a non-empty string of at most 255 characters",
          ),
        );
        return true;
      },
    );
  });

  it("requires a publishable stream and rejects server-managed EventHub extensions", () => {
    const base = {
      specversion: "1.0",
      id: "event-1",
      source: "urn:test",
      type: "com.example.test",
      datacontenttype: "application/json",
      data: null,
    } as const;

    assert.equal(
      assertPublishableCloudEvent({ ...base, eventhubstream: "engineering.alerts" })
        .eventhubstream,
      "engineering.alerts",
    );
    assert.equal(
      assertPublishableCloudEvent({
        ...base,
        time: "2026-08-01T15:20:00.123456+02:00",
        eventhubstream: "engineering.alerts",
      }).time,
      "2026-08-01T13:20:00.123Z",
    );
    assert.throws(() => assertPublishableCloudEvent(base), CloudEventValidationError);
    assert.throws(
      () =>
        assertPublishableCloudEvent({
          ...base,
          eventhubstream: "engineering",
          eventhuboffset: 42,
        }),
      CloudEventValidationError,
    );
    assert.throws(
      () =>
        assertPublishableCloudEvent({
          ...base,
          eventhubstream: "engineering",
          eventhubinternal: true,
        }),
      CloudEventValidationError,
    );
    assert.throws(
      () =>
        assertPublishableCloudEvent({
          ...base,
          eventhubstream: "engineering",
          eventhubreceivedat: "2026-08-01T13:20:00Z",
        }),
      CloudEventValidationError,
    );
  });
});

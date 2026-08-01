import { isJsonObject, type JsonValue } from "./json.js";

export interface CloudEvent {
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly subject?: string;
  readonly time?: string;
  readonly datacontenttype?: string;
  readonly dataschema?: string;
  readonly data?: JsonValue;
  readonly [extension: string]: JsonValue | undefined;
}

export interface CloudEventValidationResult {
  readonly success: boolean;
  readonly event?: CloudEvent;
  readonly errors: readonly string[];
}

const CORE_ATTRIBUTES = new Set([
  "specversion",
  "id",
  "source",
  "type",
  "subject",
  "time",
  "datacontenttype",
  "dataschema",
  "data",
]);
const ATTRIBUTE_NAME_PATTERN = /^[a-z0-9]+$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

export function validateCloudEvent(input: unknown): CloudEventValidationResult {
  if (!isJsonObject(input)) {
    return { success: false, errors: ["event must be a JSON object"] };
  }

  const errors: string[] = [];
  requireExactString(input, "specversion", "1.0", errors);
  requireString(input, "id", errors, 255);
  requireString(input, "source", errors, 512);
  requireString(input, "type", errors, 255);
  optionalString(input, "subject", errors, 1024);
  requireString(input, "datacontenttype", errors, 255);
  optionalString(input, "dataschema", errors, 2048);

  if (typeof input.source === "string") {
    try {
      new URL(input.source, "https://eventhub.invalid");
    } catch {
      errors.push("source must be a valid URI-reference");
    }
  }

  if (
    typeof input.datacontenttype === "string" &&
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(input.datacontenttype)
  ) {
    errors.push("datacontenttype must be application/json with an optional UTF-8 charset");
  }

  if (typeof input.time === "string") {
    if (!isStrictRfc3339Timestamp(input.time)) {
      errors.push("time must be an RFC 3339 timestamp");
    }
  } else if (input.time !== undefined) {
    errors.push("time must be a string when present");
  }

  if (typeof input.dataschema === "string") {
    try {
      new URL(input.dataschema);
    } catch {
      errors.push("dataschema must be an absolute URI");
    }
  }

  for (const [name, value] of Object.entries(input)) {
    if (!CORE_ATTRIBUTES.has(name)) {
      if (!ATTRIBUTE_NAME_PATTERN.test(name) || name.length > 20) {
        errors.push(
          `extension attribute ${name} must contain only lower-case letters or digits and be at most 20 characters`,
        );
      }
      if (!isCloudEventAttributeValue(value)) {
        errors.push(`extension attribute ${name} must be a scalar value`);
      }
    }
  }

  if (!("data" in input)) {
    errors.push("data is required");
  } else if (!isJsonValue(input.data)) {
    errors.push("data must be valid JSON");
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return { success: true, event: input as CloudEvent, errors: [] };
}

export function assertCloudEvent(input: unknown): CloudEvent {
  const result = validateCloudEvent(input);
  if (!result.success || result.event === undefined) {
    throw new CloudEventValidationError(result.errors);
  }
  return result.event;
}

export function assertPublishableCloudEvent(input: unknown): CloudEvent {
  const parsed = assertCloudEvent(input);
  const event: CloudEvent =
    parsed.time === undefined
      ? parsed
      : { ...parsed, time: new Date(parsed.time).toISOString() };
  const errors: string[] = [];
  const stream = event.eventhubstream;
  if (
    typeof stream !== "string" ||
    stream.length > 128 ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(stream)
  ) {
    errors.push(
      "eventhubstream is required and must match ^[a-z0-9][a-z0-9._-]*$ with at most 128 characters",
    );
  }
  if (event.eventhuboffset !== undefined) {
    errors.push("eventhuboffset is managed by EventHub and cannot be published");
  }
  if (event.eventhubreceivedat !== undefined) {
    errors.push("eventhubreceivedat is managed by EventHub and cannot be published");
  }
  for (const name of Object.keys(event)) {
    if (
      name.startsWith("eventhub") &&
      name !== "eventhubstream" &&
      name !== "eventhuboffset" &&
      name !== "eventhubreceivedat"
    ) {
      errors.push(`extension attribute ${name} uses the reserved eventhub prefix`);
    }
  }
  if (errors.length > 0) {
    throw new CloudEventValidationError(errors);
  }
  return event;
}

export class CloudEventValidationError extends Error {
  public constructor(public readonly validationErrors: readonly string[]) {
    super("CloudEvent validation failed");
    this.name = "CloudEventValidationError";
  }
}

function requireExactString(
  object: Record<string, unknown>,
  key: string,
  expected: string,
  errors: string[],
): void {
  if (object[key] !== expected) {
    errors.push(`${key} must be ${expected}`);
  }
}

function requireString(
  object: Record<string, unknown>,
  key: string,
  errors: string[],
  maximumLength: number,
): void {
  const value = object[key];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    !isPostgresSafeJsonString(value) ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    errors.push(`${key} must be a non-empty string of at most ${maximumLength} characters`);
  }
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
  errors: string[],
  maximumLength: number,
): void {
  const value = object[key];
  if (
    value !== undefined &&
    (typeof value !== "string" ||
      value.length === 0 ||
      value.length > maximumLength ||
      !isPostgresSafeJsonString(value) ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value))
  ) {
    errors.push(
      `${key} must be a non-empty string of at most ${maximumLength} characters when present`,
    );
  }
}

function isCloudEventAttributeValue(value: unknown): boolean {
  return (
    (typeof value === "string" && isPostgresSafeJsonString(value)) ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    (typeof value === "string" && isPostgresSafeJsonString(value)) ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isJsonObject(value)) {
    return Object.entries(value).every(
      ([key, item]) => isPostgresSafeJsonString(key) && isJsonValue(item),
    );
  }
  return false;
}

function isStrictRfc3339Timestamp(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isPostgresSafeJsonString(value: string): boolean {
  if (value.includes("\u0000")) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

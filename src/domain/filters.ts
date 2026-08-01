import { isJsonObject } from "./json.js";

export interface EventFilters {
  readonly stream?: string | readonly string[];
  readonly type?: string | readonly string[];
  readonly source?: string | readonly string[];
}

export function parseEventFilters(input: unknown): EventFilters {
  if (!isJsonObject(input)) {
    return {};
  }
  const stream = optionalFilter(input.stream, "stream");
  const type = optionalFilter(input.type, "type");
  const source = optionalFilter(input.source, "source");
  return {
    ...(stream === undefined ? {} : { stream }),
    ...(type === undefined ? {} : { type }),
    ...(source === undefined ? {} : { source }),
  };
}

function optionalFilter(value: unknown, name: string): string | readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > 50) {
      throw new EventFilterValidationError(`${name} must contain between 1 and 50 values`);
    }
    return value.map((item) => validateFilterValue(item, name));
  }
  return validateFilterValue(value, name);
}

function validateFilterValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new EventFilterValidationError(`${name} must be a non-empty string of at most 512 characters`);
  }
  return value;
}

export class EventFilterValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EventFilterValidationError";
  }
}

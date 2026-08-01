import { HttpError } from "./errors.js";

export function parseLimit(value: unknown, fallback = 100, maximum = 1000): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new HttpError(400, "invalid_limit", "limit must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new HttpError(
      400,
      "invalid_limit",
      `limit must be an integer between 1 and ${maximum}`,
    );
  }
  return parsed;
}

export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

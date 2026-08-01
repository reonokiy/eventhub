export const INITIAL_CURSOR = 0n;
export const MAX_CURSOR = 9_223_372_036_854_775_807n;

export function parseCursor(value: unknown, fieldName = "after"): bigint | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new CursorValidationError(`${fieldName} must be a non-negative integer`);
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new CursorValidationError(`${fieldName} is outside the supported range`);
  }
  const text = String(value);
  if (!/^(?:0|[1-9]\d*)$/.test(text)) {
    throw new CursorValidationError(`${fieldName} must be a non-negative integer`);
  }
  try {
    const cursor = BigInt(text);
    if (cursor > MAX_CURSOR) {
      throw new CursorValidationError(`${fieldName} is outside the supported range`);
    }
    return cursor;
  } catch {
    throw new CursorValidationError(`${fieldName} is outside the supported range`);
  }
}

export function formatCursor(value: bigint | string | number): string {
  return String(value);
}

export class CursorValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CursorValidationError";
  }
}

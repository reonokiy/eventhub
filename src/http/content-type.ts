import { HttpError } from "./errors.js";

export function requireContentType(actual: string | undefined, expected: string): void {
  const mediaType = actual?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== expected) {
    throw new HttpError(
      415,
      "unsupported_media_type",
      `Content-Type must be ${expected}`,
    );
  }
}

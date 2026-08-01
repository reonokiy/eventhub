import { createHash } from "node:crypto";
import type { JsonValue } from "./json.js";

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const properties = Object.keys(value)
    // RFC 8785 orders object property names by their UTF-16 code units. The
    // default Array#sort comparison has exactly that behavior; localeCompare
    // would make hashes depend on the host locale/ICU version.
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`);
  return `{${properties.join(",")}}`;
}

export function canonicalJsonSha256(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

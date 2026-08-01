import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { CursorStore, EventHubCursor } from "./client.js";

/** A small Node.js cursor store that replaces its file atomically. */
export class FileCursorStore implements CursorStore {
  readonly #path: string;

  public constructor(path: string) {
    this.#path = resolve(path);
  }

  public async load(): Promise<EventHubCursor | undefined> {
    try {
      const cursor = (await readFile(this.#path, "utf8")).trim();
      return cursor === "" ? undefined : cursor;
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async save(cursor: EventHubCursor): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${cursor}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.#path);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

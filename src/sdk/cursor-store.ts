import type { CursorStore, EventHubCursor } from "./client.js";

export class MemoryCursorStore implements CursorStore {
  #cursor: EventHubCursor | undefined;

  public constructor(initialCursor?: EventHubCursor) {
    this.#cursor = initialCursor;
  }

  public async load(): Promise<EventHubCursor | undefined> {
    return this.#cursor;
  }

  public async save(cursor: EventHubCursor): Promise<void> {
    this.#cursor = cursor;
  }
}

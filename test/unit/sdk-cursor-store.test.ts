import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { MemoryCursorStore } from "../../src/sdk/cursor-store.js";
import { FileCursorStore } from "../../src/sdk/node.js";

describe("SDK cursor stores", () => {
  it("keeps an in-memory cursor", async () => {
    const empty = new MemoryCursorStore();
    assert.equal(await empty.load(), undefined);

    const store = new MemoryCursorStore("4");
    assert.equal(await store.load(), "4");
    await store.save("5");
    assert.equal(await store.load(), "5");
  });

  it("creates, atomically replaces, and reads a file cursor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eventhub-sdk-cursor-"));
    const path = join(directory, "nested", "cursor.txt");
    const store = new FileCursorStore(path);

    try {
      assert.equal(await store.load(), undefined);
      await store.save("1043");
      assert.equal(await readFile(path, "utf8"), "1043\n");
      assert.equal(await store.load(), "1043");
      await store.save("1044");
      assert.equal(await store.load(), "1044");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("treats a blank cursor file as empty and preserves non-missing read errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eventhub-sdk-cursor-"));

    try {
      const blankStore = new FileCursorStore(join(directory, "blank.txt"));
      await blankStore.save("   ");
      assert.equal(await blankStore.load(), undefined);

      const directoryStore = new FileCursorStore(directory);
      await assert.rejects(directoryStore.load());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

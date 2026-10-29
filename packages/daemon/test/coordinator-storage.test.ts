import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, type EntryId } from "@earendil-works/pi-durable";
import { openCoordinatorStorage } from "../coordinator/storage.ts";
import { EventStore } from "../src/store.ts";

const context = BACKGROUND_CONTEXT;
const clock = () => "2026-10-29T18:40:00.000Z";

test("pi storage replays the project log, preserves unused IDs and publishes only durable commits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "armada-coordinator-"));
  const file = join(dir, "events.sqlite");
  let store = new EventStore(file);
  try {
    const storage = openCoordinatorStorage({ store, project: "a", now: clock });
    const session = createSession(storage);
    const conversation = await session.commit(
      async (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
      context,
    );
    await session.commit(async (tx) => {
      await tx.appendEntry(conversation.id, { kind: "test.note", data: { body: "kept" } });
    }, context);
    const unused = await storage.mintId();
    assert.throws(() => openCoordinatorStorage({ store, project: "a", now: clock }), /already open/);
    await session.close(context);
    store.close();
    store = new EventStore(file);
    const restored = openCoordinatorStorage({ store, project: "a", now: clock });
    assert.ok((await restored.mintId()) > unused);
    const page = await restored.scanEntries({ conversationId: conversation.id }, 10, undefined, context);
    assert.deepEqual(
      page.items.map((entry) => entry.data),
      [{ body: "kept" }],
    );
    const other = openCoordinatorStorage({ store, project: "b", now: clock });
    assert.equal(await other.conversation(conversation.id, context), undefined);
    await other.close(context);
    const entryId = await restored.mintId<EntryId>();
    store.close(); // A failed durable write must not publish to the in-memory view.
    const entry = page.items[0];
    assert.ok(entry);
    await assert.rejects(restored.commit([{ type: "entry", value: { ...entry, id: entryId } }], context));
    assert.equal(
      (await restored.scanEntries({ conversationId: conversation.id }, 10, undefined, context)).items.length,
      1,
    );
    await restored.close(context);
  } finally {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

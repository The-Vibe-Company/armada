import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/journal.ts";

test("an existing logical conversation cannot be rebound to another native session or harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-native-identity-"));
  const journal = new Journal(join(root, "journal.sqlite"), (s) => s);
  try {
    journal.saveSession("conversation", "claude", "original-native");
    journal.saveSession("conversation", "claude", "original-native");
    expect(() => journal.saveSession("conversation", "claude", "replacement-native")).toThrow(
      "native_session_identity_changed",
    );
    expect(() => journal.saveSession("conversation", "codex", "original-native")).toThrow(
      "native_session_identity_changed",
    );
    expect(journal.session("conversation")).toBe("original-native");
    journal.saveSession("explicit-new-conversation", "codex", "new-native");
    expect(journal.session("explicit-new-conversation")).toBe("new-native");
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

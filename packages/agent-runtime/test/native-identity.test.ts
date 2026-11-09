import { expect, test } from "bun:test";
import { Journal } from "../src/journal.ts";

test("an existing logical conversation cannot be rebound to another native session or harness", () => {
  const journal = new Journal(":memory:", (s) => s);
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
  }
});

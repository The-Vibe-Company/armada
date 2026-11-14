import { expect, test } from "bun:test";
import { Journal } from "../src/journal.ts";
import type { StoredPrompt } from "../src/protocol.ts";

test("prompt lookup reads only the requested record and preserves missing-record behavior", () => {
  const journal = new Journal(":memory:", (text) => text);
  const prompt: StoredPrompt = {
    promptId: "123",
    conversationId: "conversation",
    request: { sandboxId: "sandbox", harness: "codex", text: "Inspect the project" },
    status: "queued",
  };
  try {
    journal.transition(prompt, "running");
    // A damaged unrelated record must not prevent observing a valid prompt's current status.
    journal.db.query("INSERT INTO prompts VALUES(?,?,?,?)").run("unrelated", "other", "failed", "not-json");
    expect(journal.get(prompt.promptId)).toEqual({ ...prompt, status: "running" });
    expect(journal.get("missing")).toBeUndefined();
    expect(journal.get(123 as unknown as string)).toBeUndefined();
  } finally {
    journal.close();
  }
});

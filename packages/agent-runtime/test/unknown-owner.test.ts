import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_HEADER, type Driver, HarnessState, Journal, Runner } from "../src/index.ts";

const grant = {
  token: "unknown-owner-fixture-private-grant",
  sandboxId: "new-logical-id",
  generation: "1",
  expiresAt: Date.now() + 60000,
};
const driver: Driver = {
  start() {
    return { done: Promise.resolve("finished"), async interrupt() {}, async steer() {} };
  },
  async close() {},
};
async function boot(path: string) {
  const journal = new Journal(join(path, "journal.sqlite"), (s) => s);
  try {
    const state = new HarnessState(path, journal.redact);
    const sourceIdentity = journal.assertRestoreSource(grant);
    if (!journal.checkpointPending(grant)) await state.restore(grant, sourceIdentity);
    const runner = new Runner(journal, grant, { claude: driver, codex: driver });
    return { journal, runner };
  } catch (error) {
    journal.close();
    throw error;
  }
}
// Startup rejects ambiguous journal ownership before restoring native state or admitting HTTP work.
test.each(["prompts", "sessions", "events", "legacy-other-generation"])(
  "unbound %s refuse restore-source adoption",
  (kind) => {
    const journal = new Journal(":memory:", (s) => s);
    try {
      if (kind === "prompts")
        journal.transition(
          {
            promptId: "legacy-prompt",
            conversationId: "legacy-conversation",
            status: "finished",
            request: { sandboxId: "legacy-owner", harness: "claude", text: "private legacy history" },
          },
          "finished",
        );
      if (kind === "sessions") journal.saveSession("legacy-conversation", "claude", "legacy-native-session");
      if (kind === "events")
        journal.append({ id: "legacy-event", at: 1, kind: "other", type: "legacy", data: { private: "history" } });
      if (kind === "legacy-other-generation")
        journal.db.query("INSERT INTO metadata VALUES(?,?)").run("checkpoint:999", "complete");
      expect(() => journal.assertRestoreSource(grant)).toThrow("checkpoint_identity_ambiguous");
    } finally {
      journal.close();
    }
  },
);

test("unbound native files refuse restoration even when the journal is pristine", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-unbound-native-"));
  const journal = new Journal(":memory:", (s) => s);
  try {
    await mkdir(join(root, "codex/sessions/test"), { recursive: true });
    await writeFile(
      join(root, "codex/sessions/test/session.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: "legacy-native-session" } }),
    );
    const sourceIdentity = journal.assertRestoreSource(grant);
    await expect(new HarnessState(root, journal.redact).restore(grant, sourceIdentity)).rejects.toThrow(
      "checkpoint_identity_ambiguous",
    );
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("truly pristine stores still boot and admit their first prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-pristine-"));
  const live = await boot(root);
  try {
    const response = await live.runner.handle(
      new Request("https://runner", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({
          version: 1,
          requestId: "first",
          sandboxId: grant.sandboxId,
          op: "prompt",
          input: { sandboxId: grant.sandboxId, harness: "codex", text: "first prompt" },
        }),
      }),
    );
    expect(response.status).toBe(200);
  } finally {
    await new Promise<void>((r) => setImmediate(r));
    live.journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("known same-ID ownership recovers unsealed native files without pretending an unknown owner is safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-known-owner-"));
  let live = await boot(root);
  try {
    await mkdir(join(root, "codex/sessions/test"), { recursive: true });
    await writeFile(
      join(root, "codex/sessions/test/thread.jsonl"),
      JSON.stringify({ type: "fixture", word: "lantern" }),
    );
    live.journal.saveSession("own-conversation", "codex", "own-native-session");
    live.journal.close();
    live = await boot(root);
    expect(live.journal.session("own-conversation")).toBe("own-native-session");
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(join(root, "codex/sessions/test/thread.jsonl"), "utf8")).word).toBe("lantern");
  } finally {
    live.journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
// Unknown owner is not an empty-store alias. These are real copied SQL/FS states, with no mock ownership check.
test.each(["prompts", "sessions", "events", "legacy-other-generation", "native-files-only"])(
  "copied unbound %s cannot be adopted by a fresh HTTP runner",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "armada-unbound-")),
      source = join(root, "source"),
      target = join(root, "target");
    await mkdir(source);
    const journal = new Journal(join(source, "journal.sqlite"), (s) => s);
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
    if (kind === "native-files-only") {
      await mkdir(join(source, "codex/sessions/test"), { recursive: true });
      await writeFile(
        join(source, "codex/sessions/test/session.jsonl"),
        JSON.stringify({ type: "session_meta", payload: { id: "legacy-native-session" } }),
      );
    }
    journal.flush();
    journal.close();
    await cp(source, target, { recursive: true });
    let adopted: Awaited<ReturnType<typeof boot>> | undefined;
    try {
      await expect(
        (async () => {
          adopted = await boot(target);
          const health = await adopted.runner.handle(
            new Request("https://runner", {
              method: "POST",
              headers: { [AUTH_HEADER]: grant.token },
              body: JSON.stringify({ version: 1, requestId: "health", sandboxId: grant.sandboxId, op: "health" }),
            }),
          );
          return health.status;
        })(),
      ).rejects.toThrow("checkpoint_identity_ambiguous");
    } finally {
      adopted?.journal.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

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

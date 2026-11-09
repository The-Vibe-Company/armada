import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor, HarnessState, Journal } from "../src/index.ts";

// Audit: snapshot bytes and actual native-directory restoration, not an internal filename predicate.
test("checkpoint preserves sanitized native sessions but discards whole transient homes and old WAL bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-state-"));
  const credential = "fixture-rotated-private-material";
  const redact = createRedactor([credential, "tiny", "1"]);
  const state = new HarnessState(root, redact);
  try {
    await state.restore();
    for (const path of ["claude/projects/work", "claude/cache", "codex/sessions/2026", "codex/log"])
      await mkdir(join(root, path), { recursive: true });
    await writeFile(
      join(root, "claude/projects/work/session.jsonl"),
      `${JSON.stringify({
        type: "user",
        message: { content: "remember lantern" },
        headers: { Authorization: credential },
        note: "tiny",
      })}\n`,
    );
    await writeFile(
      join(root, "codex/sessions/2026/session.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          model: "gpt-6.1-sol",
          session_id: "11111111-1111-1111-1111-111111111111",
          id: "stable-thread",
          mcp_servers: { gateway: { headers: { token: credential } } },
        },
      })}\n`,
    );
    // Unknown refreshed caches are discarded without reading their contents.
    await writeFile(join(root, "codex/auth.json"), "synthetic-unread-refreshed-cache");
    await writeFile(join(root, "claude/cache/oauth-cache"), "synthetic-unread-refreshed-cache");
    await writeFile(join(root, "codex/log/output"), credential);
    const path = join(root, "journal.sqlite");
    const legacy = new Journal(path, (s) => s);
    legacy.append({
      id: "fixture",
      at: 1,
      kind: "other",
      type: "config",
      data: { headers: { Authorization: credential }, text: credential },
    });
    legacy.close();
    const journal = new Journal(path, redact);
    await state.checkpoint();
    journal.sanitize();
    journal.close();
    expect(
      await access(join(root, "codex")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(
      await access(join(root, "claude")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect((await readFile(path)).includes(Buffer.from(credential))).toBe(false);
    await state.restore();
    const claude = await readFile(join(root, "claude/projects/work/session.jsonl"), "utf8");
    expect(JSON.parse(claude).message.content).toBe("remember lantern");
    expect(claude).not.toContain(credential);
    expect(claude).not.toContain("tiny");
    const codex = await readFile(join(root, "codex/sessions/2026/session.jsonl"), "utf8");
    expect(JSON.parse(codex).payload.id).toBe("stable-thread");
    expect(JSON.parse(codex).payload.model).toBe("gpt-6.1-sol");
    expect(JSON.parse(codex).payload.session_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(codex).not.toContain(credential);
    expect(
      await access(join(root, "codex/auth.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The native transcript survives a runner crash; its former memory-only bearer
// registry does not. Restore must still scrub the published private token format.
test("same-generation native restore redacts retired authority text without its old in-memory registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-retired-authority-"));
  const identity = { sandboxId: "private-native", generation: "1" };
  const bearer = `armada_epoch_${"c".repeat(64)}`;
  let journal = new Journal(join(root, "journal.sqlite"), createRedactor([bearer]));
  try {
    journal.bindIdentity(identity);
    const directory = join(root, "codex/sessions/continuity");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, "thread.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        payload: {
          id: "preserved-thread",
          content: `Remember this ordinary tool response: ${bearer}`,
        },
      })}\n`,
    );
    journal.close();
    journal = new Journal(join(root, "journal.sqlite"), createRedactor([]));
    await new HarnessState(root, journal.redact).restore(identity, journal.assertRestoreSource(identity));
    const restored = await readFile(join(directory, "thread.jsonl"), "utf8");
    expect(restored).not.toContain(bearer);
    expect(JSON.parse(restored)).toMatchObject({
      payload: { id: "preserved-thread", content: expect.stringContaining("[REDACTED]") },
    });
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_HEADER,
  type Driver,
  type DriverContext,
  HarnessState,
  Journal,
  type McpConfiguration,
  Runner,
} from "../src/index.ts";

const secret1 = "dynamic-fixture-credential-first",
  secret2 = "dynamic-fixture-credential-second";
const config = (revision: string, value: string): McpConfiguration => ({
  revision,
  servers: {
    gateway: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: value } },
    local: { type: "stdio", command: "fixture-command", env: { MCP_PRIVATE_VALUE: value } },
  },
});
// A separate admission deadline per test; durable fsync/checkpoint work has a bounded slow-disk budget.
const IO_BUDGET_MS = 30_000;
const freshGrant = () => ({
  token: "configure-fixture-private-grant",
  sandboxId: "s",
  generation: "g1",
  expiresAt: Date.now() + 60000,
});
async function call(
  runner: Runner,
  op: string,
  extra: Record<string, unknown> = {},
  token = "configure-fixture-private-grant",
) {
  return runner.handle(
    new Request("https://runner", {
      method: "POST",
      headers: { [AUTH_HEADER]: token },
      body: JSON.stringify({ version: 1, sandboxId: "s", requestId: crypto.randomUUID(), op, ...extra }),
    }),
  );
}
// Portable owner: HTTP admission + immutable driver snapshots + actual WAL and checkpoint bytes.
test(
  "configure before first prompt replaces future/resumed turns, isolates active contexts and scrubs dynamic credentials",
  async () => {
    const grant = freshGrant();
    const root = await mkdtemp(join(tmpdir(), "armada-configure-"));
    const journal = new Journal(join(root, "journal.sqlite"), (s) => s);
    const state = new HarnessState(root, journal.redact);
    await state.restore();
    const contexts: DriverContext[] = [];
    const finish: ((s: "finished" | "interrupted") => void)[] = [];
    const driver: Driver = {
      start(c) {
        contexts.push(c);
        let resolve!: (s: "finished" | "interrupted") => void;
        const done = new Promise<"finished" | "interrupted">((r) => {
          resolve = r;
        });
        finish.push(resolve);
        c.session("native-fixture-session");
        const value =
          c.mcp?.servers.gateway?.type === "http" ? (c.mcp.servers.gateway.headers?.Authorization ?? "empty") : "empty";
        c.emit({ kind: "message", text: value, partial: false, tools: [] });
        return {
          done,
          async interrupt() {
            resolve("interrupted");
          },
          async steer() {
            c.emit({ kind: "message", text: value, partial: false, tools: [] });
          },
        };
      },
      async close() {},
    };
    const runner = new Runner(
      journal,
      grant,
      { claude: driver, codex: driver },
      {
        async append(batch) {
          return { acknowledgedSequence: batch.events.at(-1)?.sequence ?? 0 };
        },
      },
      undefined,
      async () => {
        await state.checkpoint(grant);
        journal.sanitize();
      },
    );
    try {
      const first = await call(runner, "configureMcp", {
        requestId: "shared-configure-id",
        configuration: config("r1", secret1),
      });
      expect(await first.json()).toMatchObject({ result: { revision: "r1" } });
      const a = (await (
        await call(runner, "prompt", { input: { sandboxId: "s", harness: "claude", text: "one" } })
      ).json()) as { result: { conversationId: string } };
      expect(contexts[0]?.mcp?.revision).toBe("r1");
      expect(
        (await call(runner, "configureMcp", { requestId: "shared-configure-id", configuration: config("r2", secret2) }))
          .status,
      ).toBe(200);
      expect(contexts[0]?.mcp?.revision).toBe("r1");
      expect(Object.isFrozen(contexts[0]?.mcp?.servers)).toBe(true);
      await call(runner, "steer", { conversationId: a.result.conversationId, text: "continue" });
      const duplicate = await call(runner, "configureMcp", {
        requestId: "shared-configure-id",
        configuration: config("r2", secret2),
      });
      expect(duplicate.status).toBe(200);
      expect((await call(runner, "configureMcp", { configuration: config("r2", secret1) })).status).toBe(409);
      expect((await call(runner, "configureMcp", { configuration: config("r1", secret1) })).status).toBe(409);
      finish[0]?.("finished");
      await call(runner, "interrupt", { conversationId: a.result.conversationId });
      await call(runner, "prompt", {
        input: { sandboxId: "s", harness: "claude", conversationId: a.result.conversationId, text: "resume" },
      });
      expect(contexts[1]?.sessionId).toBe("native-fixture-session");
      expect(contexts[1]?.mcp?.revision).toBe("r2");
      expect((await call(runner, "configureMcp", { configuration: { revision: "r3", servers: {} } })).status).toBe(200);
      expect(contexts[1]?.mcp?.revision).toBe("r2");
      await call(runner, "prompt", { input: { sandboxId: "s", harness: "codex", text: "independent" } });
      expect(contexts[2]?.mcp).toEqual({ revision: "r3", servers: {} });
      for (const name of await readdir(root)) {
        if (name.startsWith("journal.sqlite")) {
          const bytes = await readFile(join(root, name));
          expect(bytes.includes(Buffer.from(secret1))).toBe(false);
          expect(bytes.includes(Buffer.from(secret2))).toBe(false);
        }
      }
      expect(journal.db.query("SELECT id FROM requests WHERE id='shared-configure-id'").get()).toBe(null);
      // New dynamically registered tokens scrub saved native transcripts too, not just event payloads.
      await mkdir(join(root, "codex/sessions/test"), { recursive: true });
      await writeFile(
        join(root, "codex/sessions/test/thread.jsonl"),
        JSON.stringify({ type: "fixture", message: `${secret1} ${secret2}` }),
      );
      expect((await call(runner, "checkpoint")).status).toBe(200);
      const sealed = await readFile(join(root, "session-state/codex/sessions/test/thread.jsonl"), "utf8");
      expect(sealed).not.toContain(secret1);
      expect(sealed).not.toContain(secret2);
      expect(
        (await call(runner, "configureMcp", { requestId: "shared-configure-id", configuration: config("r4", secret1) }))
          .status,
      ).toBe(409);
      const cached = journal.db.query("SELECT body FROM requests").all() as { body: string }[];
      expect(JSON.stringify(cached)).not.toContain("configureMcp");
      expect(JSON.stringify(cached)).not.toContain("configuration");
      const restart = new Runner(journal, grant, { claude: driver, codex: driver });
      expect((await call(restart, "configureMcp", { configuration: { revision: "r5", servers: {} } })).status).toBe(
        409,
      );
    } finally {
      for (const end of finish) end("interrupted");
      await new Promise<void>((resolve) => setImmediate(resolve));
      journal.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  IO_BUDGET_MS,
);

test(
  "configure rejects malformed unions/limits and stale or expired grants without changing a valid revision",
  async () => {
    const grant = freshGrant();
    const root = await mkdtemp(join(tmpdir(), "armada-configure-deny-"));
    const journal = new Journal(join(root, "journal.sqlite"), (s) => s);
    let observed: string | undefined;
    const driver: Driver = {
      start(c) {
        observed = c.mcp?.revision;
        return { done: Promise.resolve("finished"), async steer() {}, async interrupt() {} };
      },
      async close() {},
    };
    const runner = new Runner(journal, grant, { claude: driver, codex: driver });
    try {
      await call(runner, "configureMcp", { configuration: { revision: "valid", servers: {} } });
      const bad = [
        { revision: "bad", servers: { x: { type: "http", url: "https:example.invalid" } } },
        {
          revision: "bad",
          servers: {
            x: { type: "http", url: "https://example.invalid", headers: { Authorization: "bad\u0001value" } },
          },
        },
        null,
        {},
        [],
        { revision: "bad", servers: { x: { type: "http", url: "file:///tmp/private" } } },
        { revision: "bad", servers: { x: { type: "http", url: "https://example.invalid", command: "mixed" } } },
        { revision: "bad", servers: { x: { type: "stdio", command: "x", url: "https://example.invalid" } } },
        {
          revision: "bad",
          servers: {
            x: { type: "http", url: "https://example.invalid", headers: { Authorization: "injected\r\nheader" } },
          },
        },
        { revision: "bad", servers: { x: { type: "stdio", command: "x", env: { "bad=key": "value" } } } },
        { revision: "bad", servers: { x: { type: "stdio", command: "x", args: Array(65).fill("arg") } } },
        {
          revision: "bad",
          servers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`s${i}`, { type: "stdio", command: "x" }])),
        },
      ];
      for (const configuration of bad) {
        const response = await call(runner, "configureMcp", { configuration });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "invalid_mcp_configuration" });
      }
      expect(
        (
          await call(
            runner,
            "configureMcp",
            { configuration: { revision: "stale", servers: {} } },
            "old-generation-fixture-grant",
          )
        ).status,
      ).toBe(401);
      const malformed = await runner.handle(
        new Request("https://runner", {
          method: "POST",
          headers: { [AUTH_HEADER]: grant.token },
          body: `{"op":"configureMcp","configuration":{"private":"${secret1}"`,
        }),
      );
      expect(malformed.status).toBe(409);
      expect(await malformed.text()).not.toContain(secret1);
      const expired = new Runner(journal, { ...grant, expiresAt: 0 }, { claude: driver, codex: driver });
      expect((await call(expired, "configureMcp", { configuration: config("late", secret1) })).status).toBe(401);
      await call(runner, "prompt", { input: { sandboxId: "s", harness: "codex", text: "check" } });
      expect(observed).toBe("valid");
    } finally {
      journal.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  IO_BUDGET_MS,
);

// Linux native peer sees real SDK argv/config files, including resumed turns and explicit empty removal.
test.skipIf(process.platform !== "linux")(
  "HTTP MCP updates reach real SDK/JSONL drivers without changing an active file or leaking rotated tokens",
  async () => {
    const grant = freshGrant();
    const { ClaudeDriver, CodexDriver } = await import("../src/index.ts");
    const { createHash } = await import("node:crypto");
    const root = await mkdtemp(join(tmpdir(), "armada-configure-native-"));
    const journal = new Journal(join(root, "journal.sqlite"), (s) => s);
    const state = new HarnessState(root, journal.redact);
    await state.restore();
    const claudeReceipt = join(root, "claude-receipt.json"),
      codexReceipt = join(root, "codex-receipt.json");
    const nativeClaude = new ClaudeDriver({
      executable: `${import.meta.dir}/fixtures/claude-process.ts`,
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: join(root, "claude"),
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        ARMADA_MCP_INSPECTION: claudeReceipt,
      },
    });
    const codex = new CodexDriver({
      executable: `${import.meta.dir}/fixtures/app-server.ts`,
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: join(root, "codex"),
        CODEX_HOME: join(root, "codex"),
        ARMADA_MCP_INSPECTION: codexReceipt,
      },
    });
    let codexDone: Promise<unknown> | undefined;
    const codexDriver: Driver = {
      start(c) {
        const turn = codex.start(c);
        codexDone = turn.done;
        return turn;
      },
      close: () => codex.close(),
    };
    let ready: () => void = () => {};
    const claude: Driver = {
      start(c) {
        return nativeClaude.start({
          ...c,
          emit: (e) => {
            c.emit(e);
            if (e.kind === "message" && e.partial) ready();
          },
        });
      },
      close: () => nativeClaude.close(),
    };
    const runner = new Runner(
      journal,
      grant,
      { claude, codex: codexDriver },
      {
        async append(batch) {
          return { acknowledgedSequence: batch.events.at(-1)?.sequence ?? 0 };
        },
      },
      undefined,
      async () => {
        await state.checkpoint(grant);
        journal.sanitize();
      },
    );
    const update = (revision: string, value: string): McpConfiguration => ({
      revision,
      servers: { remote: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: value } } },
    });
    const begin = async (conversationId?: string) => {
      const started = new Promise<void>((r) => {
        ready = r;
      });
      const response = await call(runner, "prompt", {
        input: { sandboxId: "s", harness: "claude", text: "initial", ...(conversationId ? { conversationId } : {}) },
      });
      const body = (await response.json()) as { result: { conversationId: string } };
      await started;
      return body.result.conversationId;
    };
    try {
      await call(runner, "configureMcp", { configuration: update("native-r1", secret1) });
      const conversation = await begin();
      const first = JSON.parse(await readFile(claudeReceipt, "utf8"));
      expect(first).toMatchObject({
        argvLeak: false,
        environmentLeak: false,
        pathOnly: true,
        fileMode: 0o600,
        directoryMode: 0o700,
      });
      expect(first.headerFingerprint).toBe(createHash("sha256").update(secret1).digest("hex"));
      await call(runner, "configureMcp", { configuration: update("native-r2", secret2) });
      expect(
        JSON.parse(await readFile(first.configPath, "utf8")).mcpServers.remote.headers.Authorization === secret1,
      ).toBe(true);
      await call(runner, "interrupt", { conversationId: conversation });
      await begin(conversation);
      const second = JSON.parse(await readFile(claudeReceipt, "utf8"));
      expect(second.resumed).toBe(true);
      expect(second.headerFingerprint).toBe(createHash("sha256").update(secret2).digest("hex"));
      expect(second.argvLeak).toBe(false);
      await call(runner, "interrupt", { conversationId: conversation });
      await call(runner, "configureMcp", { configuration: { revision: "native-r3", servers: {} } });
      await begin(conversation);
      const empty = JSON.parse(await readFile(claudeReceipt, "utf8"));
      expect(empty.serverNames).toEqual([]);
      expect(empty.strict).toBe(true);
      expect(empty.headerFingerprint).toBe(null);
      await call(runner, "interrupt", { conversationId: conversation });
      await call(runner, "prompt", { input: { sandboxId: "s", harness: "codex", text: "redirect" } });
      await codexDone;
      // Completion barrier waits for the actual app-server peer and all event ingestion, not a timer.
      expect((await call(runner, "checkpoint")).status).toBe(200);
      const removed = JSON.parse(await readFile(codexReceipt, "utf8"));
      expect(removed.serverNames).toEqual([]);
      expect(removed.argvLeak).toBe(false);
      expect(removed.environmentLeak).toBe(false);
      const events = await (await call(runner, "events")).text();
      expect(events).not.toContain(secret1);
      expect(events).not.toContain(secret2);
      expect(
        journal.events(0, 1000).some((row) => row.event.kind === "other" && row.event.type === "harness_stderr"),
      ).toBe(true);
    } finally {
      await Promise.all([nativeClaude.close(), codex.close()]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      journal.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  IO_BUDGET_MS,
);

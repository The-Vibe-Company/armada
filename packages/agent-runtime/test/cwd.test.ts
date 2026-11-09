import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_HEADER,
  ClaudeDriver,
  CodexDriver,
  type Driver,
  type DriverContext,
  Journal,
  Runner,
  type RuntimePromptRequest,
  type Turn,
} from "../src/index.ts";

// Portable HTTP/WAL owner: invalid native cwd never reaches a driver or queues a prompt.
test("private prompt cwd validates absolute normalized existing directory and persists under the same sandbox grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-cwd-protocol-"));
  const journal = new Journal(join(root, "journal.sqlite"), (s) => s);
  let seen: RuntimePromptRequest | undefined;
  const driver: Driver = {
    start(c) {
      seen = c.request;
      return { done: Promise.resolve("finished"), async interrupt() {}, async steer() {} };
    },
    async close() {},
  };
  const grant = { token: "cwd-fixture-private-grant", sandboxId: "s", generation: "g1", expiresAt: Date.now() + 60000 };
  const runner = new Runner(journal, grant, { claude: driver, codex: driver });
  const call = (cwd: unknown, token = grant.token, sandboxId = "s") =>
    runner.handle(
      new Request("https://runner", {
        method: "POST",
        headers: { [AUTH_HEADER]: token },
        body: JSON.stringify({
          version: 1,
          requestId: crypto.randomUUID(),
          sandboxId: "s",
          op: "prompt",
          input: { sandboxId, harness: "codex", text: "cwd proof", cwd },
        }),
      }),
    );
  try {
    await writeFile(join(root, "not-a-directory"), "fixture");
    for (const cwd of [
      "relative/repo",
      `${root}/../other`,
      `${root}/`,
      `${root}/missing`,
      join(root, "not-a-directory"),
      `${root}\0`,
      42,
      null,
    ]) {
      const response = await call(cwd);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "invalid_cwd" });
    }
    expect(seen).toBeUndefined();
    expect(journal.prompts()).toHaveLength(0);
    expect((await call(root, "stale-generation-fixture-token")).status).toBe(401);
    expect((await call(root, grant.token, "another-sandbox")).status).toBe(409);
    expect(seen).toBeUndefined();
    expect((await call(root)).status).toBe(200);
    expect(seen?.cwd).toBe(root);
    expect(journal.prompts()[0]?.request.cwd).toBe(root);
  } finally {
    await new Promise<void>((r) => setImmediate(r));
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});
const nativeTest = process.platform === "linux" ? test : test.skip;
// The real SDK/JSONL children create relative files in their kernel cwd. No source or path-prefix assertions.
nativeTest.each(["claude", "codex"] as const)(
  "%s native subprocess/thread cwd is turn-local across parallel conversations, steering and resume",
  async (harness) => {
    const root = await mkdtemp(join(tmpdir(), "armada-native-cwd-"));
    const fallback = join(root, "default"),
      a = join(root, "one"),
      b = join(root, "two"),
      resumed = join(root, "resumed");
    for (const dir of [fallback, a, b, resumed]) await mkdir(dir);
    const options = {
      executable: `${import.meta.dir}/fixtures/${harness === "claude" ? "claude-process" : "app-server"}.ts`,
      cwd: fallback,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_CWD_PROOF: "1" },
    };
    const driver = harness === "claude" ? new ClaudeDriver(options) : new CodexDriver(options);
    const turns: Turn[] = [];
    let sessionId: string | undefined;
    const begin = (text: string, cwd?: string, resume?: string) => {
      let ready!: () => void;
      const started = new Promise<void>((r) => {
        ready = r;
      });
      const context: DriverContext = {
        request: { sandboxId: "s", harness, text, ...(cwd ? { cwd } : {}) },
        ...(resume ? { sessionId: resume } : {}),
        signal: AbortSignal.timeout(5000),
        session: (id) => {
          sessionId = id;
        },
        emit: (e) => {
          if (e.kind === "message" && e.partial) ready();
        },
      };
      const turn = driver.start(context);
      turns.push(turn);
      return { turn, started };
    };
    const proof = async (path: string) => JSON.parse(await readFile(join(path, "native-cwd-proof.json"), "utf8"));
    try {
      const first = begin("initial-a", a);
      await first.started;
      const firstSession = sessionId;
      const second = begin("initial-b", b);
      await second.started;
      await first.turn.steer("redirect");
      expect(await first.turn.done).toBe("finished");
      const one = await proof(a),
        two = await proof(b);
      if (harness === "claude") {
        expect(one.cwd).toBe(a);
        expect(one.inputs).toEqual(["initial-a", "redirect"]);
        expect(two.cwd).toBe(b);
        expect(two.inputs).toEqual(["initial-b"]);
      } else {
        const oneRecords = one as { method: string; cwd: string; processCwd: string; text: string }[];
        expect(oneRecords.find((r) => r.method === "thread/start")?.cwd).toBe(a);
        expect(oneRecords.filter((r) => r.method === "turn/start").map((r) => ({ cwd: r.cwd, text: r.text }))).toEqual([
          { cwd: a, text: "initial-a" },
          { cwd: a, text: "redirect" },
        ]);
        expect(oneRecords.every((r) => r.processCwd === a)).toBe(true);
        const twoRecords = two as { method: string; cwd: string; processCwd: string; text: string }[];
        expect(twoRecords.filter((r) => r.method === "turn/start").map((r) => r.cwd)).toEqual([b]);
        expect(twoRecords.every((r) => r.processCwd === b)).toBe(true);
      }
      await second.turn.interrupt();
      expect(await second.turn.done).toBe("interrupted");
      const next = begin(harness === "claude" ? "resume-c" : "redirect", resumed, firstSession);
      await next.started;
      if (harness === "claude") await next.turn.steer("redirect");
      expect(await next.turn.done).toBe("finished");
      const restored = await proof(resumed);
      if (harness === "claude") {
        expect(restored.cwd).toBe(resumed);
        expect(restored.resumed).toBe(true);
      } else {
        expect(restored.find((r: { method: string }) => r.method === "thread/resume")?.cwd).toBe(resumed);
        expect(
          restored
            .filter((r: { method: string }) => r.method === "turn/start")
            .every((r: { cwd: string; processCwd: string }) => r.cwd === resumed && r.processCwd === resumed),
        ).toBe(true);
      }
      const defaultTurn = begin(harness === "claude" ? "default" : "redirect");
      await defaultTurn.started;
      if (harness === "claude") await defaultTurn.turn.steer("redirect");
      expect(await defaultTurn.turn.done).toBe("finished");
      const defaults = await proof(fallback);
      expect(
        harness === "claude"
          ? defaults.cwd
          : defaults.find((r: { method: string }) => r.method === "thread/start")?.cwd,
      ).toBe(fallback);
    } finally {
      await driver.close();
      await Promise.allSettled(turns.map((t) => t.done));
      await rm(root, { recursive: true, force: true });
    }
  },
);

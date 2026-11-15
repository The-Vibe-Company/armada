import { expect, test } from "bun:test";
import { AUTH_HEADER, type Driver, type DriverContext, Journal, type McpConfiguration, Runner } from "../src/index.ts";

const secret1 = "dynamic-fixture-credential-first",
  secret2 = "dynamic-fixture-credential-second";
const config = (revision: string, value: string): McpConfiguration => ({
  revision,
  servers: {
    gateway: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: value } },
    local: { type: "stdio", command: "fixture-command", env: { MCP_PRIVATE_VALUE: value } },
  },
});
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
// Admission and immutable driver snapshots need no filesystem or native process.
test("configure replaces future/resumed snapshots while active contexts stay immutable", async () => {
  const grant = freshGrant();
  const journal = new Journal(":memory:", (s) => s);
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
    expect(journal.db.query("SELECT id FROM requests WHERE id='shared-configure-id'").get()).toBe(null);
    const events = JSON.stringify(journal.events(0, 1000));
    expect(events).not.toContain(secret1);
    expect(events).not.toContain(secret2);
    const cached = journal.db.query("SELECT body FROM requests").all() as { body: string }[];
    expect(JSON.stringify(cached)).not.toContain("configureMcp");
    expect(JSON.stringify(cached)).not.toContain("configuration");
  } finally {
    for (const prompt of journal.prompts()) await call(runner, "interrupt", { conversationId: prompt.conversationId });
    journal.close();
  }
});

test("configure rejects malformed unions/limits and stale or expired grants without changing a valid revision", async () => {
  const grant = freshGrant();
  const journal = new Journal(":memory:", (s) => s);
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
  }
});

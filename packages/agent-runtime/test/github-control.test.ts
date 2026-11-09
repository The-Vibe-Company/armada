import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubBroker } from "../src/github-broker.ts";
import { AUTH_HEADER, type Driver, type DriverContext, Journal, Runner } from "../src/index.ts";

test("authenticated GitHub control renews during an active turn without receipts/leaks and checkpoint scrubs", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-control-"));
  const journal = new Journal(join(root, "journal"), (text) => text);
  const issued = [`offline-${crypto.randomUUID()}`, `offline-${crypto.randomUUID()}`];
  let token = issued[0]!;
  const broker = new GitHubBroker((values) => journal.registerSecrets(values), (async () =>
    Response.json({ token })) as unknown as typeof fetch);
  let context!: DriverContext, finish!: () => void;
  const done = new Promise<"finished">((resolve) => {
    finish = () => resolve("finished");
  });
  const driver: Driver = {
    start(input) {
      context = input;
      return {
        done,
        steer: async () => {},
        interrupt: async () => {
          finish();
        },
      };
    },
    close: async () => {
      finish();
    },
  };
  const grant = {
    sandboxId: "sandbox",
    generation: "generation",
    expiresAt: Date.now() + 60000,
    token: `private-${crypto.randomUUID()}`,
  };
  const runner = new Runner(
    journal,
    grant,
    { claude: driver, codex: driver },
    { append: async (batch) => ({ acknowledgedSequence: batch.events.at(-1)?.sequence ?? 0 }) },
    undefined,
    undefined,
    {
      configureGitHub: async (config) => {
        broker.configure(config);
      },
    },
  );
  const configuration = {
    version: 1 as const,
    revision: "1",
    generation: grant.generation,
    url: "https://armada.example/api/internal/github/credentials",
    expiresAt: grant.expiresAt,
    capability: `armada_gh_${"a".repeat(64)}`,
  };
  const call = (op: Record<string, unknown>, auth = grant.token) =>
    runner.handle(
      new Request("https://runner", {
        method: "POST",
        headers: { [AUTH_HEADER]: auth },
        body: JSON.stringify({ version: 1, sandboxId: grant.sandboxId, requestId: crypto.randomUUID(), ...op }),
      }),
    );
  try {
    expect((await call({ op: "configureGitHub", configuration }, "wrong")).status).toBe(401);
    expect(
      (await call({ op: "configureGitHub", configuration: { ...configuration, generation: "wrong" } })).status,
    ).toBe(409);
    expect((await call({ op: "configureGitHub", configuration })).status).toBe(200);
    const prompt = await call({
      op: "prompt",
      input: { sandboxId: grant.sandboxId, harness: "codex", text: "exercise" },
    });
    expect(prompt.status).toBe(200);
    await broker.acquire("acme/repo", "gh");
    context.emit({ kind: "other", type: "credential-leak-probe", data: { text: token } });
    token = issued[1]!;
    const renewal = await call({
      op: "configureGitHub",
      configuration: { ...configuration, revision: "2", capability: `armada_gh_${"b".repeat(64)}` },
    });
    expect(renewal.status).toBe(200);
    expect((await call({ op: "configureGitHub", configuration })).status).toBe(409);
    await broker.acquire("acme/repo", "git");
    context.emit({ kind: "other", type: "credential-leak-probe", data: { text: issued.join(" ") } });
    expect((await call({ op: "interrupt" })).status).toBe(200);
    const checkpoint = await call({ op: "checkpoint" });
    expect(checkpoint.status).toBe(200);
    await expect(broker.acquire("acme/repo", "git")).rejects.toThrow("github_credentials_denied");
    journal.flush();
    const ack = await renewal.text();
    for (const file of await readdir(root)) {
      const bytes = await readFile(join(root, file));
      for (const secret of [...issued, configuration.capability, `armada_gh_${"b".repeat(64)}`])
        expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
    for (const secret of issued) expect(ack).not.toContain(secret);
  } finally {
    finish();
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

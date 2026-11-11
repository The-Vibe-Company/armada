import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_HEADER, CodexDriver, Journal, Runner } from "../src/index.ts";

// Owner boundary: real native subprocess sees configuration; ordinary exec uses the separate environment.
test.skipIf(process.platform !== "linux")(
  "readable bootstrap reaches only intended native harness, not init/exec or request journal",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-readable-"));
    const journal = new Journal(join(root, "journal"), (s) => s);
    const proof = join(root, "proof.json");
    const driver = new CodexDriver({
      executable: join(import.meta.dir, "fixtures/app-server.ts"),
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_READABLE_INSPECTION: proof },
    });
    const grant = { token: crypto.randomUUID(), sandboxId: "s", generation: "g", expiresAt: Date.now() + 60000 };
    const runner = new Runner(journal, grant, { claude: driver, codex: driver });
    const call = async (op: string, extra: Record<string, unknown> = {}) =>
      runner.handle(
        new Request("https://runner", {
          method: "POST",
          headers: { [AUTH_HEADER]: grant.token },
          body: JSON.stringify({ version: 1, requestId: crypto.randomUUID(), sandboxId: "s", op, ...extra }),
        }),
      );
    const absent = async () => {
      const r = await call("exec", {
        input: { sandboxId: "s", cwd: root, command: 'test -z "${APP_REGION+x}" && test -z "${APP_EMPTY+x}"' },
      });
      const b = (await r.json()) as { result: { exitCode: number } };
      expect(b.result.exitCode).toBe(0);
    };
    try {
      await absent();
      for (const variables of [{ PATH: "bad" }, { OPENAI_API_KEY: "bad" }, { APP_REGION: "bad\0value" }])
        expect((await call("configureReadableVariables", { harness: "codex", variables })).status).toBe(409);
      const variables = { APP_REGION: "eu\n$(not-shell)", APP_EMPTY: "" };
      expect((await call("configureReadableVariables", { harness: "codex", variables })).status).toBe(200);
      expect((await call("configureReadableVariables", { harness: "codex", variables })).status).toBe(200);
      expect(
        (await call("configureReadableVariables", { harness: "codex", variables: { APP_REGION: "substitution" } }))
          .status,
      ).toBe(409);
      // Await the real driver's turn completion without wall-clock sleeps.
      const turn = driver.start({
        request: { sandboxId: "s", harness: "codex", text: "message-semantics" },
        signal: new AbortController().signal,
        session: () => {},
        emit: () => {},
      });
      expect(await turn.done).toBe("finished");
      expect(JSON.parse(await readFile(proof, "utf8"))).toEqual({ region: variables.APP_REGION, empty: "" });
      await absent();
      expect(JSON.stringify(journal.db.query("select * from requests").all())).not.toContain("not-shell");
      const builder = new Runner(journal, grant, { claude: driver, codex: driver }, undefined, undefined, undefined, {
        credentialFreeBuilder: true,
      });
      expect((await call("configureReadableVariables", { harness: "codex", variables })).status).toBe(200);
      const denied = await builder.handle(
        new Request("https://runner", {
          method: "POST",
          headers: { [AUTH_HEADER]: grant.token },
          body: JSON.stringify({
            version: 1,
            requestId: crypto.randomUUID(),
            sandboxId: "s",
            op: "configureReadableVariables",
            harness: "codex",
            variables,
          }),
        }),
      );
      expect(denied.status).toBe(409);
    } finally {
      await driver.close();
      journal.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

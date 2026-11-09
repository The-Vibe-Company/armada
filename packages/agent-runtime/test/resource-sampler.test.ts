import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_HEADER, type Driver, Journal, Runner } from "../src/index.ts";

// Exercises read-only transport against the test machine's /proc. This is NOT provider isolation evidence.
test("resource observation requires auth, rejects extra inputs and bypasses replay/event/process persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "armada-resource-reading-"));
  const grant = {
    token: "fixture-private-resource-grant",
    sandboxId: "logical",
    generation: "g1",
    expiresAt: Date.now() + 60000,
  };
  const unused: Driver = {
    start() {
      throw Error("model must not start");
    },
    async close() {},
  };
  const journal = new Journal(join(dir, "journal"), (text) => text);
  const runner = new Runner(journal, grant, { claude: unused, codex: unused });
  const request = (token: string, extra: object = {}) =>
    runner.handle(
      new Request("https://runner/v1", {
        method: "POST",
        headers: { [AUTH_HEADER]: token },
        body: JSON.stringify({
          version: 1,
          sandboxId: grant.sandboxId,
          requestId: "reading",
          op: "resourceObservation",
          ...extra,
        }),
      }),
    );
  try {
    expect((await request("wrong")).status).toBe(401);
    expect((await request(grant.token, { path: "/etc/passwd" })).status).toBe(409);
    const cached = JSON.stringify({ version: 1, requestId: "reading", result: { cached: "not-observation" } });
    journal.db.query("INSERT INTO requests VALUES(?,?)").run("reading", cached);
    for (let i = 0; i < 2; i++) {
      const response = await request(grant.token);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { version: number; requestId: string; result: unknown };
      expect(body).toMatchObject({ version: 1, requestId: "reading" });
      expect(body.result).not.toEqual({ cached: "not-observation" });
      if (body.result !== null) expect(body.result).toMatchObject({ version: 1 });
    }
    expect(journal.db.query("SELECT body FROM requests WHERE id='reading'").get()).toEqual({ body: cached });
    expect(journal.db.query("SELECT count(*) as count FROM requests").get()).toEqual({ count: 1 });
    expect(journal.events(0, 100)).toHaveLength(0);
    expect(journal.db.query("SELECT count(*) as count FROM processes").get()).toEqual({ count: 0 });
  } finally {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

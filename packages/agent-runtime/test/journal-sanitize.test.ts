import { expect, test } from "bun:test";
import { Journal } from "../src/journal.ts";

test("sanitation visits every one-row batch, preserves identities and repeats for newly registered secrets", () => {
  const journal = new Journal(":memory:", (text) => text);
  try {
    for (const table of ["events", "prompts", "requests", "processes"]) {
      for (const id of [-1, 2, 9]) {
        const body = `keep_${id} old_secret later_secret`;
        if (table === "prompts")
          journal.db
            .query("INSERT INTO prompts(rowid,id,conversation,status,body) VALUES(?,?,'c','done',?)")
            .run(id, `p_${id}`, body);
        else if (table === "requests")
          journal.db.query("INSERT INTO requests(rowid,id,body) VALUES(?,?,?)").run(id, `r_${id}`, body);
        else journal.db.query(`INSERT INTO ${table}(rowid,body) VALUES(?,?)`).run(id, body);
      }
    }
    journal.registerSecrets(["old_secret"]);
    journal.sanitize();
    journal.registerSecrets(["later_secret"]);
    journal.sanitize();
    journal.sanitize();
    for (const table of ["events", "prompts", "requests", "processes"]) {
      expect(journal.db.query(`SELECT rowid AS id,body FROM ${table} ORDER BY rowid`).all()).toEqual(
        [-1, 2, 9].map((id) => ({ id, body: `keep_${id} [REDACTED] [REDACTED]` })),
      );
    }
  } finally {
    journal.close();
  }
});

test("scrub failure leaves checkpoint preparing without a receipt", async () => {
  const { Runner } = await import("../src/runtime.ts");
  const journal = new Journal(":memory:", (text) => {
    if (text === "body") throw Error("scrub_failed");
    return text;
  });
  const grant = { token: "fixture_runtime_secret", sandboxId: "s", generation: "g", expiresAt: Date.now() + 60000 };
  const runner = new Runner(journal, grant, {}, undefined, undefined, async () => journal.sanitize());
  try {
    journal.db.query("INSERT INTO requests VALUES('r','body')").run();
    const response = await runner.handle(
      new Request("https://runner/v1", {
        method: "POST",
        headers: { "x-armada-runner-grant": grant.token },
        body: JSON.stringify({ version: 1, sandboxId: "s", requestId: "checkpoint_request", op: "checkpoint" }),
      }),
    );
    expect(response.status).not.toBe(200);
    expect(await response.text()).toContain("scrub_failed");
    expect(journal.db.query("SELECT value FROM metadata WHERE key LIKE 'checkpoint:%'").all()).toEqual([
      { value: "preparing" },
    ]);
  } finally {
    journal.close();
  }
});

import { expect, test } from "bun:test";
import { Journal } from "../src/journal.ts";

test("sanitation visits every one-row batch, preserves identities and repeats for newly registered secrets", () => {
  const journal = new Journal(":memory:", (text) => text);
  try {
    for (const table of ["events", "prompts", "requests", "processes"]) {
      for (const id of [-1n, 2n, 9n, 9007199254740993n]) {
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
      expect(journal.db.query(`SELECT CAST(rowid AS TEXT) AS id,body FROM ${table} ORDER BY rowid`).all()).toEqual(
        [-1n, 2n, 9n, 9007199254740993n].map((id) => ({ id: String(id), body: `keep_${id} [REDACTED] [REDACTED]` })),
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

test("emits server-valid tool metadata after literal and short application redaction", async () => {
  const { createRuntimeEnrolments, RuntimeEnrolmentDenied } = await import("../../mcp-server/src/runtime-enrolment.ts");
  const { createRuntimeEvents } = await import("../../mcp-server/src/runtime-events.ts");
  const authority = createRuntimeEnrolments(
    {
      query: async () => {
        throw Error("unexpected database query");
      },
    },
    "test",
  );
  const check = createRuntimeEvents(authority, "test");
  for (const shortMask of [false, true]) {
    const journal = new Journal(":memory:", (text) => text);
    try {
      journal.registerSecrets(["longsecrt"]);
      if (shortMask) journal.registerApplicationSecrets(["xy"]);
      const value = `${"a".repeat(254)}😀\0${shortMask ? "xy" : "longsecrt"}`;
      const expands = `${"a".repeat(247)}${shortMask ? "xy" : "longsecrt"}`;
      journal.append({
        id: "evt",
        at: 1,
        kind: "message",
        text: "",
        partial: false,
        tools: [
          { id: expands, name: expands, server: expands },
          { id: value, name: "", server: "\0" },
          { id: "other", name: "other" },
        ],
      });
      const events = journal.events();
      const event = events[0]?.event;
      if (event?.kind !== "message") throw Error("missing message");
      await expect(check.append("test", "1", { sandboxId: "s", generation: "1", events })).rejects.toBeInstanceOf(
        RuntimeEnrolmentDenied,
      );
      const redacted = `${"a".repeat(247)}[REDACTED`;
      expect(event.tools).toEqual([
        { id: redacted, name: redacted, server: redacted },
        { id: `${"a".repeat(254)}😀`, name: "tool", server: "tool" },
        { id: "other", name: "other" },
      ]);
    } finally {
      journal.close();
    }
  }
});

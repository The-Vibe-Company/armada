import { expect, test } from "bun:test";
import { createSqlSandboxStore, type Sql } from "@armada/core/server";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeServing } from "../src/runtime-serving.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

test("serving factory authorizes persisted binding and reads stopped runtime archive without cloud access", async () => {
  const { db, people } = await database();
  try {
    const sql: Sql = {
      query: (q, v) => db.query(q, v),
      transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
    };
    const golden = (
      await db.query<{ id: string }>("select id from goldens where owner_id=$1 and visibility='private' limit 1", [
        people.owner,
      ])
    ).rows[0];
    if (!golden) throw Error("missing owned golden");
    const row = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "physical",
      goldenId: golden.id,
      orgId: people.org,
      ownerId: people.owner,
      harness: "codex",
      status: "ready",
      model: "gpt-5.4",
      reasoningEffort: "high",
      boatRuntime: true,
    });
    const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
    const active = await authority.enrol(
      (await authority.issue({ sandboxId: row.id, ownerId: people.owner, configuration: {} })).enrolmentToken,
    );
    await createRuntimeEvents(authority, ENCRYPTION_KEY).append(active.runtimeToken, active.epoch, {
      sandboxId: row.id,
      generation: active.epoch,
      events: [
        {
          sequence: 1,
          event: { id: "answer", at: 1, kind: "message", text: "runtime answer", partial: false, tools: [] },
        },
        {
          sequence: 2,
          event: { id: "terminal", at: 2, kind: "prompt", promptId: "prompt", status: "finished", text: "reply" },
        },
      ],
    });
    await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [row.id]);
    const target = {
      id: row.id,
      boatRuntime: true as const,
      provider: "boat" as const,
      orgId: people.org,
      visibility: "private" as const,
      modal: null,
    };
    const serving = createRuntimeServing(sql, ENCRYPTION_KEY);
    const provider = await serving("unused-cloud-key", target, { userId: people.owner });
    expect(await provider.events({ sandboxId: "physical" })).toMatchObject({
      source: "armada-runtime",
      events: [{ text: "runtime answer" }, { kind: "prompt", status: "finished" }],
    });
    expect(await provider.getPrompt({ sandboxId: "physical", promptId: "prompt" })).toMatchObject({
      status: "finished",
      done: true,
    });
    await db.query(
      "update sandboxes set status='failed',status_reason='Armada runtime process failed.',task_prompt_id='prompt' where id=$1",
      [row.id],
    );
    const failed = await serving("unused-cloud-key", target, { userId: people.owner });
    // A later process failure must never rewrite a durably finished prompt.
    expect(await failed.getPrompt({ sandboxId: "physical", promptId: "prompt" })).toMatchObject({
      status: "finished",
      done: true,
    });
    await db.query("update sandboxes set task_prompt_id='unarchived-prompt' where id=$1", [row.id]);
    const empty = await serving("unused-cloud-key", target, { userId: people.owner });
    expect(await empty.getPrompt({ sandboxId: "physical", promptId: "unarchived-prompt" })).toMatchObject({
      status: "failed",
      done: true,
    });
    await expect(empty.getPrompt({ sandboxId: "physical", promptId: "unrelated" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await empty.events({ sandboxId: "physical" })).runtimeFailure).toEqual({
      status: "failed",
      reason: "Armada runtime process failed.",
    });
    await expect(serving("unused-cloud-key", target, { userId: people.member })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      serving("unused-cloud-key", { ...target, visibility: "org" }, { userId: people.owner }),
    ).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await db.close();
  }
});

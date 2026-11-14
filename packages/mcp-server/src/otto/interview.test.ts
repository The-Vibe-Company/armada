import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import type { PGlite } from "@electric-sql/pglite";
import { openMigratedDatabase } from "../../../../scripts/test-support/migrated-database.ts";
import type { OttoInterviewRound } from "../../../core/src/otto/interview.ts";
import { dispatchIntention } from "./intentions.ts";
import { interviewStore } from "./interview.ts";

let db: PGlite;
const orgId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const otherOwnerId = "44444444-4444-4444-8444-444444444444";
const objectiveId = "33333333-3333-4333-8333-333333333333";
const sql: Sql = { query: (text, params) => db.query(text, params) };
const scope = { orgId, ownerId, objectiveId };
const engine = { harness: "codex" as const, model: "selected_model", credentialId: "account_reference" };
const round: OttoInterviewRound = {
  decisions: [
    {
      id: "platform",
      question: "Which platform?",
      recommendation: "Web",
      answer: null,
      source: null,
      reversible: false,
      dependsOn: [],
    },
    {
      id: "browser",
      question: "Which browsers?",
      recommendation: "Modern browsers",
      answer: null,
      source: null,
      reversible: true,
      dependsOn: ["platform"],
    },
  ],
  assumptions: [{ text: "Existing styles", source: "Repository inspection" }],
  frontier: ["platform"],
};
beforeAll(async () => {
  db = await openMigratedDatabase();
  await db.query("insert into auth.users(id) values ($1),($2)", [ownerId, otherOwnerId]);
  await db.query("insert into public.orgs(id,name) values ($1,'Interview test')", [orgId]);
  await db.query("insert into public.members(org_id,user_id,role) values ($1,$2,'admin')", [orgId, ownerId]);
  await db.query("insert into public.members(org_id,user_id,role) values ($1,$2,'admin')", [orgId, otherOwnerId]);
  await db.query(
    "insert into public.otto_objectives(id,org_id,owner_id,repository,request) values ($1,$2,$3,'owner/repo','Build feature')",
    [objectiveId, orgId, ownerId],
  );
});
afterAll(async () => {
  await db?.close();
});

test("restart restores exact rounds, sourced decisions, owner events and immutable engine selection", async () => {
  const store = interviewStore(sql, scope);
  await store.start(engine, "golden_reference");
  expect((await store.start({ ...engine, model: "different_model" }, "other_golden")).engine).toEqual(engine);
  await store.publish(1, round);
  await store.answer(2, "1. Web, enough, go", true);
  await store.bindSession("sandbox_reference");
  const restored = await interviewStore(sql, scope).read();
  expect(restored).toMatchObject({
    revision: 4,
    sandboxId: "sandbox_reference",
    round,
    answers: [{ revision: 3, body: "1. Web, enough, go", enough: true }],
    enough: true,
  });
  const history = await db.query<{ event: string; snapshot: unknown }>(
    "select event,snapshot from public.otto_interview_revisions where objective_id=$1 order by revision",
    [objectiveId],
  );
  expect(history.rows.map((r) => r.event)).toEqual(["started", "round", "owner_answer", "session_bound"]);
  expect(history.rows[1]?.snapshot).toMatchObject({ revision: 2, answers: [], round });
  await expect(store.answer(2, "Stale answer", false)).rejects.toThrow("revision conflict");
  await expect(store.publish(4, { ...round, frontier: ["browser"] })).rejects.toThrow("Frontier");
  const settled: OttoInterviewRound = {
    ...round,
    decisions: round.decisions.map((decision) =>
      decision.id === "platform" ? { ...decision, answer: "Web", source: "Owner answer at revision 3" } : decision,
    ),
    frontier: ["browser"],
  };
  await store.publish(4, settled);
  const reopened = await interviewStore(sql, scope).read();
  expect(reopened?.round?.decisions[0]).toMatchObject({
    id: "platform",
    answer: "Web",
    source: "Owner answer at revision 3",
  });
  await expect(store.publish(5, { ...settled, decisions: [], frontier: [] })).rejects.toThrow(
    "Settled decisions must remain",
  );
  const changed = {
    ...settled,
    decisions: settled.decisions.map((decision) =>
      decision.id === "platform" ? { ...decision, answer: "Mobile", source: "Engine guess" } : decision,
    ),
  };
  await expect(store.publish(5, changed)).rejects.toThrow("new owner answer");
  await expect(
    store.publish(5, { ...settled, assumptions: [...settled.assumptions, ...settled.assumptions] }),
  ).rejects.toThrow("Assumption text must be unique");
  expect((await store.answer(5, "Actually choose mobile", false)).enough).toBe(true);
  expect((await store.publish(6, changed)).round?.decisions[0]?.answer).toBe("Mobile");
});

test("journal persists before effect, claims once and never repeats ambiguous effects or changed payloads", async () => {
  let calls = 0;
  const effect = async () => {
    calls++;
    expect(
      (
        await db.query<{ state: string }>(
          "select state from public.otto_intentions where idempotency_key='launch_once'",
        )
      ).rows[0]?.state,
    ).toBe("dispatching");
    throw new Error("Acknowledgement lost");
  };
  const results = await Promise.all([
    dispatchIntention(sql, scope, "launch_once", "engine_start", { golden: "chosen" }, effect),
    dispatchIntention(sql, scope, "launch_once", "engine_start", { golden: "chosen" }, effect),
  ]);
  expect(calls).toBe(1);
  expect(results.map((r) => r.status)).toEqual(["unknown", "unknown"]);
  expect(
    (await dispatchIntention(sql, scope, "launch_once", "engine_start", { golden: "chosen" }, effect)).status,
  ).toBe("unknown");
  await expect(
    dispatchIntention(sql, scope, "launch_once", "engine_start", { golden: "different" }, effect),
  ).rejects.toThrow("different intention");
  const success = await dispatchIntention(sql, scope, "message_once", "message", { body: "Begin" }, async () => ({
    receipt: "acknowledged",
  }));
  expect(success).toEqual({ status: "succeeded", result: { receipt: "acknowledged" } });
  expect(await dispatchIntention(sql, scope, "message_once", "message", { body: "Begin" }, effect)).toEqual(success);
  expect(calls).toBe(1);
});

test("user JWT can reopen its own snapshots but cannot read another owner or the effect journal", async () => {
  for (const [user, count] of [
    [ownerId, 1],
    [otherOwnerId, 0],
  ] as const) {
    await db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
      await tx.exec("set local role authenticated");
      expect((await tx.query("select snapshot from public.otto_interviews")).rows).toHaveLength(count);
      expect((await tx.query("select snapshot from public.otto_interview_revisions")).rows).toHaveLength(count * 7);
    });
  }
  await expect(
    db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
      await tx.exec("set local role authenticated");
      await tx.query("select payload,result from public.otto_intentions");
    }),
  ).rejects.toThrow("permission denied");
});

test("revoked membership and another owner cannot read, mutate or dispatch private interviews", async () => {
  const outsider = interviewStore(sql, { ...scope, ownerId: otherOwnerId });
  expect(await outsider.read()).toBeNull();
  await expect(outsider.start(engine, "golden_reference")).rejects.toThrow("unavailable");
  await db.query("delete from public.members where org_id=$1 and user_id=$2", [orgId, ownerId]);
  const store = interviewStore(sql, scope);
  expect(await store.read()).toBeNull();
  await expect(store.answer(4, "Unauthorized", false)).rejects.toThrow("unavailable");
  let called = false;
  await expect(
    dispatchIntention(sql, scope, "revoked", "message", {}, async () => {
      called = true;
    }),
  ).rejects.toThrow("unavailable");
  expect(called).toBe(false);
});

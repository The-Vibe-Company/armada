import { expect, test } from "bun:test";
import { templateLaunchResponse } from "@armada/core/contract";
import { scopeKey } from "@armada/provider-modal";
import { rowOnlyDatabase } from "../test/row-only-database.ts";
import { settleModalTemplateReceipts } from "./modal-template-receipt-settlement.ts";
import { sqlOver } from "./sql.ts";

const database = rowOnlyDatabase();

async function fixture() {
  const { db, people } = await database();
  const sql = sqlOver({
    unsafe: async (query, params) => (await db.query(query, params)).rows,
    begin: (work) =>
      db.transaction((tx) => work({ unsafe: async (query, params) => (await tx.query(query, params)).rows })),
  });
  const sandboxId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const goldenId = crypto.randomUUID();
  const binding = { workspace: "workspace", environment: "main", appId: "ap-fixture" };
  const manifest = { golden: { id: goldenId, provider: "modal", modal: binding, visibility: "org" } };
  const { rows } = await db.query<{ version: string }>(
    `with template as (
       insert into launch_templates(org_id,owner_id,scope,name) values($1,$2,'org','fixture') returning id
     ), revision as (
       insert into launch_template_revisions(template_id,revision,definition,digest,created_by)
       select id,1,'{}',repeat('a',64),$2 from template returning id,template_id
     )
     insert into template_launch_requests
       (id,org_id,actor_id,client_key,digest,template_id,revision_id,manifest,sandbox_id,state,created_at)
     select $3,$1,$2,'fixture-key',repeat('b',64),template_id,id,$4,$5,'reconciling','2026-11-17T11:30:06Z' from revision
     returning xmin::text as version`,
    [people.org, people.owner, requestId, manifest, sandboxId],
  );
  const row = {
    requestId,
    sandboxId,
    orgId: people.org,
    actorId: people.owner,
    receiptVersion: rows[0]!.version,
    sandboxVersion: null,
    binding,
    visibility: "org" as const,
  };
  const journal = async (record: Record<string, unknown>) => {
    const { rows } = await db.query<{ version: string }>(
      `insert into modal_machines (scope,org_id,owner_id,visibility,id,request_key,record)
       values($1,$2,$3,'org',$4,$5,$6) returning xmin::text as version`,
      [
        scopeKey({ ...row, userId: row.actorId }),
        row.orgId,
        row.actorId,
        "modal-logical-fixture",
        crypto.randomUUID(),
        { ...record, golden: false, info: { labels: { org: row.orgId, owner: row.actorId, sandbox: sandboxId } } },
      ],
    );
    return rows[0]!.version;
  };
  const read = async () =>
    (
      await db.query(
        "select state, result from template_launch_requests where org_id=$1 and actor_id=$2 and client_key='fixture-key'",
        [people.org, people.owner],
      )
    ).rows[0];
  return { db, sql, row, journal, read, manifest };
}

test("historical labels correlate a full deletion tombstone and settlement preserves the scoped receipt", async () => {
  const { sql, row, journal, read, manifest } = await fixture();
  const journalVersion = await journal({ phase: "deleted", generation: 1, deletePhysicalExitGeneration: 1 });
  const input = [{ ...row, evidence: { kind: "delete-tombstone", journalVersion } }];
  expect(await settleModalTemplateReceipts(sql, input, true)).toEqual([{ row: 1, decision: "delete-tombstone" }]);
  expect(await read()).toEqual({ state: "reconciling", result: null });
  expect(await settleModalTemplateReceipts(sql, input, false)).toEqual([{ row: 1, decision: "delete-tombstone" }]);
  const terminal = await read();
  expect(terminal).toMatchObject({
    state: "failed",
    result: { state: "failed", requestId: row.requestId, id: row.sandboxId, manifest },
  });
  expect(templateLaunchResponse.safeParse(terminal?.result).success).toBe(true);
  expect(await settleModalTemplateReceipts(sql, input, false)).toEqual([{ row: 1, decision: "already-terminal" }]);
  expect(await read()).toEqual(terminal);
});

test("settlement defers on a stale receipt version even with exact absence evidence", async () => {
  const { db, sql, row, read } = await fixture();
  await db.query("update template_launch_requests set reason='new-observation' where id=$1", [row.requestId]);
  const input = [{ ...row, evidence: { kind: "confirmed-absence", reference: "reviewed exact inventory" } }];
  expect(await settleModalTemplateReceipts(sql, input, false)).toEqual([{ row: 1, decision: "deferred" }]);
  expect(await read()).toEqual({ state: "reconciling", result: null });
});

test("a matching historical journal without full exit proof blocks settlement", async () => {
  const { sql, row, journal, read } = await fixture();
  const journalVersion = await journal({ phase: "deleted", generation: 2, deletePhysicalExitGeneration: 1 });
  expect(
    await settleModalTemplateReceipts(sql, [{ ...row, evidence: { kind: "delete-tombstone", journalVersion } }], false),
  ).toEqual([{ row: 1, decision: "deferred" }]);
  expect(await read()).toEqual({ state: "reconciling", result: null });
});

test("reviewed final absence can close an exact receipt with no database owner or journal", async () => {
  const { sql, row, read } = await fixture();
  const input = [{ ...row, evidence: { kind: "confirmed-absence", reference: "reviewed exact inventory" } }];
  expect(await settleModalTemplateReceipts(sql, input, false)).toEqual([{ row: 1, decision: "confirmed-absence" }]);
  expect(await read()).toMatchObject({ state: "failed", result: { id: row.sandboxId } });
});

test("verified original success preserves the historical public receipt", async () => {
  const { db, sql, row, journal, read, manifest } = await fixture();
  const golden = manifest.golden;
  const providerSandboxId = "modal-logical-fixture";
  await db.query(
    `insert into goldens (id,org_id,owner_id,name,visibility,provider,modal_workspace,modal_environment,modal_app_id)
       values ($1,$2,$3,'historical-modal','org','modal',$4,$5,$6)`,
    [golden.id, row.orgId, row.actorId, row.binding.workspace, row.binding.environment, row.binding.appId],
  );
  const { rows } = await db.query<{ version: string }>(
    `insert into sandboxes (id,golden_id,org_id,owner_id,harness,provider,status,provider_sandbox_id)
       values ($1,$2,$3,$4,'codex','modal','ready',$5) returning xmin::text as version`,
    [row.sandboxId, golden.id, row.orgId, row.actorId, providerSandboxId],
  );
  const journalVersion = await journal({ phase: "active", generation: 1 });
  const receipt = {
    requestId: row.requestId,
    id: row.sandboxId,
    state: "succeeded",
    provider: "modal",
    providerSandboxId,
    status: "ready",
    promptId: "original-prompt",
    manifest: { ...manifest, skillReceipts: [] },
  };
  const input = [
    {
      ...row,
      sandboxVersion: rows[0]!.version,
      evidence: { kind: "original-receipt", journalVersion, reference: "reviewed receipt", receipt },
    },
  ];
  expect(await settleModalTemplateReceipts(sql, input, false)).toEqual([{ row: 1, decision: "original-receipt" }]);
  expect(await read()).toEqual({ state: "succeeded", result: receipt });
});

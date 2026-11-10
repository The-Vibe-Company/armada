import assert from "node:assert/strict";
import type { Sql } from "@armada/core/server";
import { catalogReceipt, catalogReference } from "./skillpack-catalog.ts";

// Owns the public serve launch contract, with only external provider I/O faked.
export async function checkSandboxSkillLaunch(input: {
  sql: Sql;
  orgId: string;
  body: object;
  request(action: string, body: object): Promise<{ status: number; body: any }>;
  allocations(): number;
  prompts(): number;
  stops(): number;
  order: string[];
}) {
  const { sql, orgId, request } = input;
  const orderStart = input.order.length;
  const launched = await request("launch", {
    ...input.body,
    skills: [catalogReference],
    repo: "fixture",
    prompt: "Read the installed notes skill.",
  });
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  const id = launched.body.sandbox.id;
  assert.deepEqual(launched.body.sandbox.skills, [catalogReceipt]);
  assert(launched.body.conversationId, "Successful skill launch must start the requested first turn");
  const order = input.order.slice(orderStart);
  assert(
    order.indexOf("install") >= 0 && order.indexOf("install") < order.indexOf("prompt"),
    "Install must finish before first turn",
  );
  assert(order.includes("exclude"), "Checkout must locally exclude installed skill files");
  const detail = await request("status", { id });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.deepEqual(detail.body.skills, [catalogReceipt], "Status must read the persisted verified receipt");
  const stopped = await request("stop", { id });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  const allocations = input.allocations();
  for (const invalidPin of ["example/notes", "notes@1.0.0"]) {
    const invalid = await request("launch", { ...input.body, skills: [invalidPin], prompt: "Must not run" });
    assert(invalid.status >= 400, JSON.stringify(invalid.body));
    assert.equal(input.allocations(), allocations, "Invalid or private pins must fail before public launch allocation");
  }
  const before = await sql.query<{ id: string }>("select id from sandboxes where org_id=$1", [orgId]);
  const prompts = input.prompts();
  const stops = input.stops();
  const failed = await request("launch", { ...input.body, skills: ["example/missing@1.0.0"], prompt: "Must not run" });
  assert(failed.status >= 400, JSON.stringify(failed.body));
  assert(
    !JSON.stringify(failed.body).includes("synthetic-"),
    "Installer failure must not expose guest diagnostics or credentials",
  );
  assert.equal(input.prompts(), prompts, "Failed install must never start the first turn");
  const rows = await sql.query<{
    id: string;
    status: string;
    stopped_at: unknown;
    conversation_ids: string[];
    skills: unknown[];
  }>("select id,status::text,stopped_at,conversation_ids,skills from sandboxes where org_id=$1", [orgId]);
  const added = rows.rows.filter((row) => !before.rows.some((prior) => prior.id === row.id));
  assert.equal(added.length, 1, "Failed allocated launch must remain inspectable");
  assert.equal(added[0]!.status, "failed");
  assert.equal(input.stops(), stops + 1, "Failed installation must stop the allocated machine");
  assert.deepEqual(added[0]!.conversation_ids, []);
  assert.deepEqual(added[0]!.skills, []);
}

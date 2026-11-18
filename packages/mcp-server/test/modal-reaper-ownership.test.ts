import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ProviderInventoryMachine } from "@armada/core";
import { PGlite } from "@electric-sql/pglite";
import { createModalReaperOwnership } from "../src/modal-reaper-ownership.ts";

const machine = {
  sandboxId: "modal_logical",
  machineId: "sb-physical",
  generation: "3",
  deploymentId: "server",
  createdAt: new Date(0),
} satisfies ProviderInventoryMachine;
const binding = { workspace: "work", environment: "env", appId: "ap-bound" };
const signal = new AbortController().signal;
const db = new PGlite();
const lookup = createModalReaperOwnership({ query: (statement, params) => db.query(statement, params) }, binding);

beforeAll(async () => {
  await db.exec(`
    create table goldens (id uuid primary key, modal_workspace text, modal_environment text, modal_app_id text);
    create table sandboxes (
      id uuid primary key, provider text, provider_sandbox_id text, status text,
      org_id uuid, owner_id uuid, golden_id uuid
    );
    create table modal_machines (scope text, id text, record jsonb, org_id uuid, owner_id uuid);
    create table modal_server_scopes (scope text primary key, context jsonb);

    insert into goldens values
      ('10000000-0000-0000-0000-000000000001','work','env','ap-bound'),
      ('10000000-0000-0000-0000-000000000002','work','env','ap-other');
    insert into sandboxes values
      ('20000000-0000-0000-0000-000000000001','modal','modal_logical','failed',
       '30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001'),
      ('20000000-0000-0000-0000-000000000002','modal','modal_foreign','running',
       '30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002'),
      ('20000000-0000-0000-0000-000000000003','modal','modal_owner_conflict','failed',
       '30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001');
    insert into modal_server_scopes values
      ('scope','{"binding":{"workspace":"work","environment":"env","appId":"ap-bound"}}'),
      ('second_scope','{"binding":{"workspace":"work","environment":"env","appId":"ap-bound"}}'),
      ('other_scope','{"binding":{"workspace":"work","environment":"env","appId":"ap-other"}}');
    insert into modal_machines values
      ('scope','modal_logical','{"physicalId":"sb-physical","generation":3}',
       '30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001'),
      ('scope','modal_pending','{"physicalId":"sb-pending","generation":1}',
       '30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001'),
      ('other_scope','modal_wrong_app','{"physicalId":"sb-wrong-app","generation":3}',
       '30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001'),
      ('scope','modal_owner_conflict','{"physicalId":"sb-owner-conflict","generation":3}',
       '30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001'),
      ('scope','modal_duplicate','{"physicalId":"sb-duplicate","generation":3}',
       '30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001'),
      ('second_scope','modal_duplicate','{"physicalId":"sb-duplicate-other","generation":1}',
       '30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001');
  `);
});

afterAll(() => db.close());

test.each([
  ["provider-only allocation", { sandboxId: "modal_pending", machineId: "sb-pending" }, { kind: "absent" }],
  ["exact terminal generation", {}, { kind: "owned", status: "failed", generation: "3" }],
  ["stale generation tag", { generation: "4" }, { kind: "owned", status: "failed" }],
  ["different physical ID", { machineId: "sb-replacement" }, { kind: "owned", status: "failed" }],
  ["reverse mapping conflicts with the tag", { sandboxId: "modal_other" }, { kind: "unresolved" }],
  ["canonical-only cross-App tag", { sandboxId: "modal_foreign", machineId: "sb-foreign" }, { kind: "unresolved" }],
  ["provider-only cross-App tag", { sandboxId: "modal_wrong_app", machineId: "sb-wrong-app" }, { kind: "unresolved" }],
  [
    "conflicting canonical and provider owners",
    { sandboxId: "modal_owner_conflict", machineId: "sb-owner-conflict" },
    { kind: "unresolved" },
  ],
  ["ambiguous provider records", { sandboxId: "modal_duplicate", machineId: "sb-duplicate" }, { kind: "unresolved" }],
] as const)("Modal reaper ownership for %s", async (_name, inventory, expected) => {
  expect(await lookup({ ...machine, ...inventory }, signal)).toEqual(expected);
});

test("a Modal ownership query failure propagates for the next sweep to retry", async () => {
  const failure = new Error("database read timed out");
  const failingLookup = createModalReaperOwnership(
    {
      async query() {
        throw failure;
      },
    },
    binding,
  );

  await expect(failingLookup(machine, signal)).rejects.toBe(failure);
});

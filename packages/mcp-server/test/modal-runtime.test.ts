import { expect, test } from "bun:test";
import { createSqlSandboxStore, type Sql } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeServing } from "../src/runtime-serving.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

// SQL is the owner of immutable routing, epoch handoff and stopped archive authority.
// This protects Modal admission (previously Boat/Docker only), not provider inference.
test("Modal dial-out persists routing and retains enrolled authority through launch but not stop", async () => {
  const { db, people } = await database();
  try {
    const sql: Sql = {
      query: (q, v) => db.query(q, v),
      transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
    };
    const golden = (
      await db.query<{ id: string }>(
        `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
      values($1,$2,'dialout-modal','private','modal','master','image','workspace','main','app','{"repos":[],"init":[]}') returning id`,
        [people.org, people.owner],
      )
    ).rows[0]!;
    const caller = {
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" as const }],
      via: "service" as const,
    };
    const store = createSqlData(sql)(caller).sandboxes;
    const row = await store.insert({
      id: crypto.randomUUID(),
      provider: "modal",
      runtimeTransport: "dialout",
      providerSandboxId: "modal-machine",
      goldenId: golden.id,
      orgId: people.org,
      ownerId: people.owner,
      harness: "codex",
      status: "starting",
      activityLeaseId: crypto.randomUUID(),
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    expect((await store.get(row.id))?.runtimeTransport).toBe("dialout");
    expect(
      (await createSqlSandboxStore(sql).listBefore(new Date(Date.now() + 1000).toISOString())).find(
        (r) => r.id === row.id,
      )?.runtimeTransport,
    ).toBe("dialout");
    await expect(db.query("update sandboxes set runtime_transport=null where id=$1", [row.id])).rejects.toThrow(
      "transport is immutable",
    );
    const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
    const active = await authority.enrol(
      (await authority.issue({ sandboxId: row.id, ownerId: people.owner, configuration: {} })).enrolmentToken,
    );
    await db.query(
      "update sandboxes set status='running',lifecycle_generation=lifecycle_generation+1,activity_lease_id=null,activity_until=null,task_prompt_id='p' where id=$1",
      [row.id],
    );
    await authority.withSession(active.runtimeToken, active.epoch, async () => true);
    const events = createRuntimeEvents(authority, ENCRYPTION_KEY);
    await events.append(active.runtimeToken, active.epoch, {
      sandboxId: row.id,
      generation: active.epoch,
      events: [
        {
          sequence: 1,
          event: { id: "answer", at: 1, kind: "message", promptId: "p", text: "MODAL_OK", partial: false, tools: [] },
        },
        {
          sequence: 2,
          event: { id: "finish", at: 2, kind: "prompt", promptId: "p", status: "finished", text: "reply" },
        },
      ],
    });
    await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [row.id]);
    await expect(authority.withSession(active.runtimeToken, active.epoch, async () => true)).rejects.toThrow();
    const host = { ...fakeBoat().provider, id: "modal" as const };
    const provider = await createRuntimeServing(sql, ENCRYPTION_KEY)(
      host,
      {
        id: row.id,
        runtimeTransport: "dialout",
        provider: "modal",
        orgId: people.org,
        visibility: "private",
        modal: { workspace: "workspace", environment: "main", appId: "app" },
      },
      { userId: people.owner },
    );
    expect(await provider.events({ sandboxId: "modal-machine" })).toMatchObject({
      source: "armada-runtime",
      events: [{ text: "MODAL_OK" }, { status: "finished" }],
    });
  } finally {
    await db.close();
  }
});

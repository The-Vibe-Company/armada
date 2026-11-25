import { expect, test } from "bun:test";
import { createServiceToken, createSqlAuthStore } from "@armada/auth";
import { DOCKER_HOST_PROTOCOL } from "@armada/core";
import { sandboxRelayOperations } from "@armada/core/contract";
import { createSqlVaultStore } from "@armada/core/server";
import type { ServerWebSocket } from "bun";
import { handleControlRequest } from "../src/control.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createRelayHub, type RelaySocketData } from "../src/relay-hub.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { sqlOver } from "../src/sql.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY, PUBLIC_URL } from "./support.ts";

const sharedDb = rowOnlyDatabase(),
  op = sandboxRelayOperations.mintTicket,
  now = new Date("2026-11-08T12:00:00.000Z");

async function fixture() {
  const { db, people } = await sharedDb();
  const sql = sqlOver({
    unsafe: async (q, v) => (await db.query(q, v)).rows,
    begin: (work) => db.transaction((tx) => work({ unsafe: async (q, v) => (await tx.query(q, v)).rows })),
  });
  const authStore = createSqlAuthStore(sql);
  const tok = async (userId: string) =>
    (await createServiceToken(authStore, { userId, orgName: "Example", now })).token;
  const [ownerToken, memberToken, adminToken] = await Promise.all([
    tok(people.owner),
    tok(people.member),
    tok(people.admin),
  ]);
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY, { allowDockerIssue: true });
  const hub = createRelayHub({
    sql,
    authority,
    encryptionKey: ENCRYPTION_KEY,
    publicUrl: PUBLIC_URL,
    dashboardUrl: "https://dashboard.example.com",
    clock: { now: () => now.getTime(), every: () => () => {}, after: () => () => {} },
  });
  const hosts = createDockerHostStore(sql, ENCRYPTION_KEY),
    inst = crypto.randomUUID(),
    gen = crypto.randomUUID();
  const host = await hosts.exchangeRegistration(
    (await hosts.issueRegistration({ userId: people.admin, orgId: people.org })).registrationToken,
    inst,
  );
  await db.query("update public.docker_hosts set daemon_protocol=$2 where id=$1", [host.hostId, DOCKER_HOST_PROTOCOL]);
  await db.query("insert into public.mcp_actor_epochs(org_id,user_id,epoch) values($1,$2,1) on conflict do nothing", [
    people.org,
    people.admin,
  ]);
  const modalGolden = (
    await db.query<{ id: string }>(
      `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
     values($1,$2,'relay-modal','private','modal','m-master','m-img','ws','main','app','{"repos":[],"init":[]}') returning id`,
      [people.org, people.owner],
    )
  ).rows[0]!.id;
  const [boatId, modalId, dockerId] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,provider,harness,status,boat_runtime,expires_at)
     select $1,id,org_id,owner_id,'boat-relay','boat','codex','ready',true,now()+interval '1 hour'
     from goldens where owner_id=$2 and visibility='private' and provider='boat' limit 1`,
    [boatId, people.owner],
  );
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,runtime_transport,expires_at)
     values($1,$2,$3,$4,'modal','modal-relay','codex','ready','dialout',now()+interval '1 hour')`,
    [modalId, modalGolden, people.org, people.owner],
  );
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,docker_host_id,docker_installation_id,docker_generation,docker_image,expires_at)
     values($1,null,$2,$3,'docker',$6,'codex','running',$4,$5,$7,$8,now()+interval '1 hour')`,
    [
      dockerId,
      people.org,
      people.owner,
      host.hostId,
      inst,
      `armada-${inst}-${host.hostId}-${dockerId}-${gen}`,
      gen,
      `worker@sha256:${"a".repeat(64)}`,
    ],
  );
  const connectRuntime = async (sandboxId: string) => {
    const enrolled = await authority.enrol(
      (await authority.issue({ sandboxId, ownerId: people.owner, configuration: {} })).enrolmentToken,
    );
    let data: RelaySocketData | undefined;
    expect(
      await hub.upgradeRuntime(
        new Request(`${PUBLIC_URL}/api/runtime/relay`, {
          headers: {
            upgrade: "websocket",
            authorization: `Bearer ${enrolled.runtimeToken}`,
            "x-armada-runtime-epoch": enrolled.epoch,
          },
        }),
        (d) => {
          data = d;
          return true;
        },
      ),
    ).toBeUndefined();
    hub.websocket.open?.({
      data: data!,
      send: () => 1,
      close: () => {},
    } as unknown as ServerWebSocket<RelaySocketData>);
  };
  const opts = {
    authStore,
    store: createSqlVaultStore(sql),
    supabase: { supabaseUrl: "https://supa.example", anonKey: "anon" },
    encryptionKey: ENCRYPTION_KEY,
    relayHub: hub,
    now: () => now,
  };
  const mint = (sandboxId: string, body: unknown, token: string | null = ownerToken) =>
    handleControlRequest(
      new Request(`${PUBLIC_URL}/api/v1/sandboxes/${sandboxId}/relay-ticket`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      opts,
    );
  return { db, hub, boatId, modalId, dockerId, memberToken, adminToken, connectRuntime, mint };
}

test("mints tickets for Boat, Modal, and golden-less Docker sandboxes and enforces auth/taint/state", async () => {
  const f = await fixture();
  try {
    expect((await f.mint(f.boatId, { mode: "pty" }, null))!.status).toBe(401);
    for (const [id, body] of [
      ["not-a-uuid", { mode: "pty" }],
      [f.boatId, { mode: "preview" }],
      [f.boatId, `{"mode":"pty","cwd":"/${"a".repeat(33_000)}"}`],
    ] as const) {
      const r = (await f.mint(id, body))!;
      expect([r.status, op.errorOutput.parse(await r.json()).error.code]).toEqual([400, "invalid_request"]);
    }
    const disc = (await f.mint(f.boatId, { mode: "pty" }))!;
    expect([disc.status, op.errorOutput.parse(await disc.json()).error.code]).toEqual([503, "relay_unavailable"]);
    for (const [id, body] of [
      [f.boatId, { mode: "pty", cwd: "/workspace" }],
      [f.modalId, { mode: "tcp", port: 5173 }],
      [f.dockerId, { mode: "preview", port: 3000 }],
    ] as const) {
      await f.connectRuntime(id);
      const r = (await f.mint(id, body))!;
      expect([r.status, r.headers.get("cache-control")]).toEqual([200, "no-store"]);
      expect(op.output.parse(await r.json())).toMatchObject({ wsUrl: "wss://armada.example.com/api/v1/relay/ws" });
    }
    expect((await f.mint(f.dockerId, { mode: "pty" }, f.adminToken))!.status).toBe(200);
    const denied = (await f.mint(f.boatId, { mode: "pty" }, f.memberToken))!;
    expect([denied.status, op.errorOutput.parse(await denied.json()).error.code]).toEqual([404, "not_found"]);
    await f.db.query("update sandboxes set application_secret_tainted=true where id=$1", [f.boatId]);
    const tainted = (await f.mint(f.boatId, { mode: "pty" }))!;
    expect([tainted.status, op.errorOutput.parse(await tainted.json()).error.code]).toEqual([403, "forbidden"]);
    await f.db.query("update sandboxes set stop_requested_at=now() where id=$1", [f.modalId]);
    const stopping = (await f.mint(f.modalId, { mode: "tcp" }))!;
    expect([stopping.status, op.errorOutput.parse(await stopping.json()).error.code]).toEqual([
      409,
      "sandbox_not_ready",
    ]);
    await f.db.query("update sandboxes set deleted_at=now(),status='deleted' where id=$1", [f.modalId]);
    expect((await f.mint(f.modalId, { mode: "tcp" }))!.status).toBe(404);
  } finally {
    await f.hub.stop();
  }
});

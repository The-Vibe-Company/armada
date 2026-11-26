import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { decryptSecret, encryptSecret, type ModalBinding } from "@armada/core";
import { modalLaunchReceipt } from "@armada/core/contract";
import { createSqlVaultStore } from "@armada/core/server";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { MODAL_INITIAL_TURN } from "../src/jobs/modal-launch.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { createModalIntegration } from "../src/modal-integration.ts";
import type { AdmitModalLaunch } from "../src/modal-launch-admission.ts";
import { modalAdmissionFixture } from "./modal-admission.fixture.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { bunLikeSql, call, ENCRYPTION_KEY, fakeBoat, harness, PUBLIC_URL, type TestServer } from "./support.ts";

const database = rowOnlyDatabase();
let pendingServer: Promise<TestServer> | undefined;

afterEach(async () => {
  const pending = pendingServer;
  pendingServer = undefined;
  const server = await pending?.catch(() => undefined);
  await server?.close();
});

function start(options: Parameters<typeof harness>[0] = {}) {
  const pending = database().then((fixture) => harness({ enrolledLaunch: true, ...options }, fixture));
  pendingServer = pending;
  return pending.then((server) => {
    if (pendingServer !== pending) throw new Error("Server fixture teardown has started");
    return server;
  });
}

const BINDING: ModalBinding = { workspace: "ws-acme", environment: "main", appId: "ap-0123456789abcdef" };
const PAIR = { token_id: "ak-orgtoken0001", token_secret: "as-orgsecret0001" };
const ROTATED = { token_id: "ak-orgtoken0002", token_secret: "as-orgsecret0002" };

type LaunchTimingSample = {
  event: string;
  surface: string;
  sandboxId: string;
  sqlStatements: number;
  stages: { name: string; sqlStatements: number }[];
};

function launchSamples(log: { mock: { calls: unknown[][] } }) {
  return log.mock.calls
    .map(([line]) => JSON.parse(String(line)) as LaunchTimingSample)
    .filter(({ event }) => event === "modal_golden_launch_timing");
}

/** A Modal golden named like the Boat org golden 'shared', written as the server would (service role). */
async function seedModal(target: TestServer) {
  const { db, people } = target;
  await db.query(
    `insert into goldens (org_id, name, visibility, owner_id, provider, provider_snapshot_id, modal_workspace,
       modal_environment, modal_app_id, config)
     values ($1, 'shared', 'org', $2, 'modal', 'image', $3, $4, $5, $6::jsonb)`,
    [
      people.org,
      people.admin,
      BINDING.workspace,
      BINDING.environment,
      BINDING.appId,
      JSON.stringify({ repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }], init: [] }),
    ],
  );
  await setOrgModalPair(target, PAIR);
}

async function setOrgModalPair(target: TestServer, pair: typeof PAIR) {
  await target.db.query(
    `insert into credentials (scope, owner_id, kind, value_enc) values ('org', $1, 'modal', $2)
     on conflict (scope, owner_id, kind) where kind in ('boat','modal') do update set value_enc = excluded.value_enc`,
    [target.people.org, await encryptSecret(JSON.stringify(pair), ENCRYPTION_KEY)],
  );
}

describe("provider routing", () => {
  test("a same-name Modal golden is listed apart, named explicitly, and never launched on Boat", async () => {
    const server = await start();
    await seedModal(server);
    const token = await server.token(server.people.member);
    const mcp = await server.client(token);
    const listed = await handleControlRequest(
      new Request(PUBLIC_URL + "/api/v1/golden/list", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
      }),
      {
        authStore: server.auth,
        supabase: { supabaseUrl: "https://unused.test", anonKey: "test" },
        store: createSqlVaultStore(server.db),
        encryptionKey: ENCRYPTION_KEY,
        data: createSqlData(server.db),
      },
    );
    expect(listed?.status).toBe(200);
    const body = (await listed?.json()) as { goldens: Record<string, unknown>[] };
    const shared = body.goldens.filter((golden) => golden.name === "shared");
    expect(
      shared.map(({ provider, providerSnapshotId, modal }) => ({
        provider,
        providerSnapshotId: providerSnapshotId === null ? null : "set",
        modal,
      })),
    ).toEqual([
      { provider: "boat", providerSnapshotId: "set", modal: null },
      { provider: "modal", providerSnapshotId: "set", modal: BINDING },
    ]);
    expect(JSON.stringify(body)).not.toContain(PAIR.token_secret);

    const ambiguous = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    expect(ambiguous.text).toContain("error code: invalid");
    const unconfigured = await call(mcp, "launch", { golden: "shared", provider: "modal", harness: "claude" });
    expect(unconfigured.isError).toBe(true);
    expect(unconfigured.text).toContain("error code: provider_routing_unavailable");
    expect(server.boat.forks).toEqual([]);

    const onBoat = await call(mcp, "launch", { golden: "shared", provider: "boat", harness: "claude" });
    expect(modalLaunchReceipt.parse(onBoat.data).sandbox.status).toBe("starting");
    expect(server.boat.forks).toHaveLength(0);
  });

  test("MCP admits work on the pinned Modal App and replays the receipt after org credential rotation", async () => {
    let admit: AdmitModalLaunch;
    const server = await start({ admitModalLaunch: (...args) => admit(...args) });
    await seedModal(server);
    const { db, people } = server;
    await db.query(
      `insert into modal_server_apps(org_id,authority,authority_scope,authority_owner_id,app_name,app_id,environment)
       values($1,$2,'org',$1,'org-app',$3,$4)`,
      [people.org, `org:${people.org}`, BINDING.appId, BINDING.environment],
    );
    const sql = bunLikeSql(db);
    const vault = createSqlVaultStore(sql);
    const integration = createModalIntegration({
      sql,
      vault,
      encryptionKey: ENCRYPTION_KEY,
      publicUrl: PUBLIC_URL,
    });
    admit = await modalAdmissionFixture(
      sql,
      ENCRYPTION_KEY,
      vault,
      { orgId: people.org, userId: people.member, visibility: "org", binding: BINDING },
      (actor, golden) => integration.launchProviderFor(golden, actor),
    );
    const mcp = await server.client(await server.token(people.member));
    const request = { golden: "shared", provider: "modal", harness: "claude", idempotencyKey: "pinned-app-launch" };
    const receipt = modalLaunchReceipt.parse((await call(mcp, "launch", request)).data);
    expect(receipt.sandbox.status).toBe("starting");
    await setOrgModalPair(server, ROTATED);
    expect((await call(mcp, "launch", request)).data).toEqual(receipt);
    expect(
      (
        await db.query(
          `select s.source_golden_visibility,g.modal_app_id,s.provider_sandbox_id
       from sandboxes s join goldens g on g.id=s.golden_id where s.id=$1`,
          [receipt.sandbox.id],
        )
      ).rows,
    ).toEqual([{ source_golden_visibility: "org", modal_app_id: BINDING.appId, provider_sandbox_id: null }]);
    expect((await db.query("select sandbox_id from jobs where kind='launch'")).rows).toEqual([
      { sandbox_id: receipt.sandbox.id },
    ]);
    expect(server.boat.forks).toEqual([]);
  });

  test("REST preserves the initial Modal prompt and attributes receipt SQL only to the fresh launch", async () => {
    const modal = fakeBoat();
    const server = await start();
    await seedModal(server);
    const { db, people } = server;
    const token = await server.token(people.member);
    const sql = bunLikeSql(db);
    const provider = {
      ...modal.provider,
      id: "modal" as const,
      managementIdentity: async () => ({ scope: "org" as const, ownerId: people.org }),
    };
    const options = {
      authStore: server.auth,
      supabase: { supabaseUrl: "https://unused.test", anonKey: "test" },
      store: createSqlVaultStore(sql),
      encryptionKey: ENCRYPTION_KEY,
      data: createSqlData(sql),
      providerFor: () => provider,
      providers: { resolve: async () => provider },
      admitModalLaunch: await modalAdmissionFixture(
        sql,
        ENCRYPTION_KEY,
        createSqlVaultStore(sql),
        { orgId: people.org, userId: people.member, visibility: "org", binding: BINDING },
        provider,
      ),
    };
    const launch = () =>
      handleControlRequest(
        new Request(PUBLIC_URL + "/api/v1/sandbox/launch", {
          method: "POST",
          headers: { authorization: "Bearer " + token },
          body: JSON.stringify({
            golden: "shared",
            provider: "modal",
            harness: "codex",
            prompt: "Inspect the repository.",
            idempotencyKey: "modal-timing-request",
          }),
        }),
        options,
      );

    const log = spyOn(console, "info");
    try {
      const fresh = await launch();
      expect(fresh?.status).toBe(200);
      const response = modalLaunchReceipt.parse(await fresh?.json());
      const replay = await launch();
      expect(replay?.status).toBe(200);
      expect(await replay?.json()).toEqual(response);
      expect(modal.forks).toHaveLength(0);
      const jobs = createJobsStore(sql, ENCRYPTION_KEY);
      const launchJob = await jobs.claim("launch", crypto.randomUUID(), 30, 1);
      expect(await jobs.claim(MODAL_INITIAL_TURN, crypto.randomUUID(), 30, 1)).toBeUndefined();
      const {
        rows: [setupRow],
      } = await db.query<{ sandbox_id: string; payload_enc: Uint8Array<ArrayBuffer> }>(
        "select sandbox_id, payload_enc from jobs where sandbox_id=$1 and kind=$2",
        [response.sandbox.id, MODAL_INITIAL_TURN],
      );
      expect(setupRow?.sandbox_id).toBe(response.sandbox.id);
      expect(JSON.parse(await decryptSecret(setupRow!.payload_enc, ENCRYPTION_KEY))).toMatchObject({
        launchJobId: launchJob?.id,
        prompt: "Inspect the repository.",
      });

      const samples = launchSamples(log);
      expect(samples).toHaveLength(1);
      const sample = samples[0];
      expect(sample).toMatchObject({ surface: "rest", sandboxId: response.sandbox.id });
      expect(sample?.stages.find(({ name }) => name === "admission")?.sqlStatements).toBeGreaterThan(0);
      expect(sample?.stages.find(({ name }) => name === "receipt_admission")?.sqlStatements).toBeGreaterThan(0);
      expect(sample?.stages.find(({ name }) => name === "response_publication")?.sqlStatements).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});

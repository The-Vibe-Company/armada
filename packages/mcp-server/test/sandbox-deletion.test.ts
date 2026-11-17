import { expect, test } from "bun:test";
import { encryptSecret, type Provider, ProviderError } from "@armada/core";
import { createSqlVaultStore } from "@armada/core/server";
import {
  createModalProvider,
  createSqlModalStore,
  type Machine,
  type RunnerDistribution,
  type Scope,
} from "@armada/provider-modal";
import type { ModalClient } from "modal";
import type { AuthIo } from "../../cli/src/auth-commands.ts";
import { run } from "../../cli/src/run.ts";
import { memorySessionStore } from "../../cli/src/session.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { providerRegistry } from "../src/http.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { call, ENCRYPTION_KEY, harness, PUBLIC_URL, SECRETS } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

// The shared HTTP/MCP boundary, real migrations and SQL activity CAS own deletion policy.
// A mocked store would miss authorization, archive cleanup and concurrent resume admission.
test("sandbox deletion authorizes live owners/admins, fences activity, and preserves history only after provider success", async () => {
  const server = await harness({}, await sharedDatabase());
  let release: (() => void) | undefined;
  let deletion: Promise<Response> | undefined;
  try {
    const { people: p, db, boat } = server;
    const ownerToken = await server.token(p.owner);
    const memberToken = await server.token(p.member);
    const adminToken = await server.token(p.admin);
    const owner = await server.client(ownerToken);
    const store = createSqlVaultStore(db);
    const options: ControlOptions = {
      authStore: server.auth,
      store,
      encryptionKey: ENCRYPTION_KEY,
      supabase: { supabaseUrl: "https://project.supabase.co", anonKey: "anon" },
      data: createSqlData(db),
      providers: providerRegistry({ vault: store, encryptionKey: ENCRYPTION_KEY, providerFor: boat.providerFor }),
      now: () => server.clock.now,
    };
    const request = async (id: string, token = ownerToken, method = "DELETE") => {
      const response = await handleControlRequest(
        new Request(`${PUBLIC_URL}/api/v1/sandboxes/${id}`, {
          method,
          headers: { authorization: `Bearer ${token}` },
        }),
        options,
      );
      if (!response) throw new Error("Missing deletion route.");
      return response;
    };
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!;
    const insert = async (status = "stopped", providerId = `bx_${crypto.randomUUID()}`) => {
      const id = crypto.randomUUID();
      await db.query(
        `insert into sandboxes(id,boat_id,golden_id,org_id,owner_id,harness,status,visibility,stopped_at,model,reasoning_effort)
        values($1,$2,$3,$4,$5,'claude',$6::sandbox_status,'private',case when $6='stopped' then now() else null end,'claude-sonnet-4-6','medium')`,
        [id, providerId, golden.id, p.org, p.owner, status],
      );
      return id;
    };
    const state = async (id: string) =>
      (
        await db.query<{ status: string; deleted_at: Date | null; preservation_note: string | null }>(
          "select status::text,deleted_at,preservation_note from sandboxes where id=$1",
          [id],
        )
      ).rows[0]!;
    const calls: string[] = [];
    boat.provider.delete = async ({ sandboxId }) => {
      calls.push(sandboxId);
      return { status: "deleted" };
    };
    const usage = async (id: string) =>
      (
        await db.query<{ seconds: number | null }>(
          "select usage_runtime_seconds as seconds from sandboxes where id=$1",
          [id],
        )
      ).rows[0]!.seconds;
    const id = await insert();
    // Status can confirm provider closure before reconciliation clears this stop flag.
    await db.query("update sandboxes set usage_runtime_seconds=42,stop_requested_at=clock_timestamp() where id=$1", [
      id,
    ]);
    await db.query("insert into sandbox_work_recovery(sandbox_id,archive_enc) values($1,$2)", [
      id,
      new Uint8Array([1]),
    ]);
    await db.query("update sandboxes set preservation_note='preserved' where id=$1", [id]);
    expect((await request(id, memberToken)).status).toBe(404);
    expect((await request(id, ownerToken, "POST")).status).toBe(405);
    for (const status of ["starting", "ready", "running", "stopping"]) {
      const active = await insert(status);
      const refused = await request(active);
      expect(refused.status).toBe(409);
      expect((await state(active)).status).toBe(status);
    }
    expect(calls).toEqual([]);
    const removed = await request(id);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ id, status: "deleted" });
    const history = await state(id);
    expect(history.status).toBe("deleted");
    expect(await usage(id)).toBe(42);
    expect(history.deleted_at).not.toBeNull();
    expect(history.preservation_note).toBeNull();
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toEqual([]);
    expect((await request(id)).status).toBe(200);
    expect(await state(id)).toEqual(history);
    expect(calls).toHaveLength(1);
    const listed = await call(owner, "list");
    expect((listed.data.sandboxes as { id: string }[]).map((row) => row.id)).not.toContain(id);

    const failed = await insert("failed");
    await db.query("update sandboxes set usage_running_since='2026-01-01T00:00:00Z' where id=$1", [failed]);
    boat.provider.delete = async () => {
      throw new ProviderError({ provider: "boat", code: "unavailable", message: "offline", retryable: true });
    };
    const providerFailure = await request(failed);
    expect(providerFailure.status).toBe(502);
    expect(await providerFailure.json()).toMatchObject({ error: { code: "provider_unavailable" } });
    expect((await state(failed)).status).toBe("failed");
    expect((await state(failed)).deleted_at).toBeNull();
    const retry = await request(failed);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: "sandbox_not_ready" } });
    await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [failed]);
    boat.provider.delete = async () => ({ status: "pending" });
    expect((await request(failed)).status).toBe(409);
    expect((await state(failed)).status).toBe("failed");
    await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [failed]);
    boat.provider.delete = async () => {
      throw new ProviderError({ provider: "boat", code: "not_found", message: "gone", retryable: false });
    };
    expect((await request(failed, adminToken)).status).toBe(200);
    expect(await usage(failed)).toBeNull();

    // A Modal lifecycle-lease refusal never dispatched deletion. The stopped row keeps
    // its state and admits the immediate retry instead of refusing it as not ready.
    const leased = await insert();
    boat.provider.delete = async () => {
      throw new ProviderError({
        provider: "modal",
        code: "conflict",
        providerCode: "lifecycle_lease_busy",
        message: "leased",
        retryable: true,
      });
    };
    const busy = await request(leased);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "conflict" } });
    expect((await state(leased)).status).toBe("stopped");
    boat.provider.delete = async () => ({ status: "deleted" });
    expect((await request(leased)).status).toBe(200);
    expect((await state(leased)).status).toBe("deleted");

    const mcpId = await insert();
    expect((await call(owner, "delete", { id: mcpId })).data).toEqual({ id: mcpId, status: "deleted" });
    const parent = await insert();
    const orchestrator = crypto.randomUUID();
    await db.query("insert into orchestrators(id,org_id,owner_id,sandbox_id) values($1,$2,$3,$4)", [
      orchestrator,
      p.org,
      p.owner,
      parent,
    ]);
    const child = await insert();
    await db.query(
      "insert into orchestrator_children(sandbox_id,orchestrator_id,org_id,owner_id) values($1,$2,$3,$4)",
      [child, orchestrator, p.org, p.owner],
    );
    for (const managed of [parent, child]) {
      const refused = await request(managed);
      expect(refused.status).toBe(409);
      const body = (await refused.json()) as { error: { message: string } };
      expect(body.error.message).toContain("own lifecycle");
      expect((await state(managed)).status).toBe("stopped");
    }

    // Ordinary delegated children keep their history, but become removable only
    // after permanent parent deletion has fenced all future delegated authority.
    const delegatedParent = await insert();
    const delegatedChild = await insert();
    await db.query(
      "insert into armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state) values($1,'sandbox',$2,$3,$1,'stopped')",
      [delegatedParent, p.org, p.owner],
    );
    await db.query(
      "insert into orchestrator_children(sandbox_id,orchestrator_id,org_id,owner_id) values($1,$2,$3,$4)",
      [delegatedChild, delegatedParent, p.org, p.owner],
    );
    boat.provider.delete = async ({ sandboxId }) => {
      calls.push(sandboxId);
      return { status: "deleted" };
    };
    const beforeDelegatedDeletion = calls.length;
    expect((await request(delegatedChild)).status).toBe(409);
    expect(calls).toHaveLength(beforeDelegatedDeletion);
    expect((await request(delegatedParent)).status).toBe(200);
    expect((await state(delegatedParent)).status).toBe("deleted");
    const otherOrgToken = await server.token(p.member, p.otherOrg);
    for (const token of [memberToken, otherOrgToken]) {
      expect((await request(delegatedChild, token)).status).toBe(404);
    }
    expect(calls).toHaveLength(beforeDelegatedDeletion + 1);
    expect((await request(delegatedChild)).status).toBe(200);
    expect((await state(delegatedChild)).status).toBe("deleted");
    expect(calls).toHaveLength(beforeDelegatedDeletion + 2);
    expect(
      (await db.query("select sandbox_id from orchestrator_children where sandbox_id=$1", [delegatedChild])).rows,
    ).toEqual([{ sandbox_id: delegatedChild }]);

    const cliId = await insert();
    boat.provider.delete = async () => ({ status: "deleted" });
    let output = "",
      errors = "",
      sent = 0;
    const auth: AuthIo = {
      env: { ARMADA_URL: PUBLIC_URL, ARMADA_TOKEN: ownerToken },
      session: memorySessionStore(),
      now: () => server.clock.now,
      open: () => undefined,
      out: (s) => {
        output += s;
      },
      err: () => undefined,
      fetch: async (input, init) => {
        sent++;
        const req = new Request(String(input), init);
        expect(req.method).toBe("DELETE");
        expect(new URL(req.url).pathname).toBe(`/api/v1/sandboxes/${cliId}`);
        return (await handleControlRequest(req, options))!;
      },
    };
    const io = {
      out: (s: string) => {
        output += s;
      },
      err: (s: string) => {
        errors += s;
      },
    };
    expect(await run(["rm", cliId], io, { auth })).not.toBe(0);
    expect(errors).toContain("--yes");
    expect(sent).toBe(0);
    expect(await run(["rm", cliId, "--yes", "--json", "--org", p.org], io, { auth })).toBe(0);
    expect(JSON.parse(output)).toEqual({ id: cliId, status: "deleted" });
    expect(sent).toBe(1);

    const physical = await boat.provider.fork({ from: "snapshot" });
    await boat.provider.stop({ sandboxId: physical.id });
    const raced = await insert("stopped", physical.id);
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    boat.provider.delete = async () => {
      admitted();
      await wait;
      return { status: "deleted" };
    };
    deletion = request(raced);
    await started;
    const resumed = await call(owner, "send", { id: raced, prompt: "resume" });
    expect(resumed.isError).toBe(true);
    expect(resumed.text).toContain("error code: sandbox_not_ready");
    expect(boat.prompts).toHaveLength(0);
    release?.();
    expect((await deletion).status).toBe(200);
    expect((await state(raced)).status).toBe("deleted");
  } finally {
    release?.();
    await Promise.allSettled([deletion]);
    await server.close();
  }
});

// Wrong-account not_found is not proof that the owner's retained resources are gone.
// Exercise both real entrypoints with distinct provider accounts, not a fake policy store.
test("admin extension and deletion resolve private-source resources through their owner's provider account", async () => {
  const retained = new Set(["bx_private_api", "bx_private_mcp"]);
  const accounts: string[] = [];
  const adminKey = "boat-admin-test-account-distinct";
  const providerFor = (key: string): Provider =>
    ({
      id: "boat" as const,
      async extendLifetime() {
        accounts.push(key === SECRETS.personalBoat ? "owner" : "wrong-account");
        if (key !== SECRETS.personalBoat)
          throw new ProviderError({ provider: "boat", code: "not_found", message: "Wrong account", retryable: false });
        return new Date(Date.now() + 3_600_000);
      },
      async delete({ sandboxId }: { sandboxId: string }) {
        accounts.push(key === SECRETS.personalBoat ? "owner" : "wrong-account");
        if (key !== SECRETS.personalBoat)
          throw new ProviderError({ provider: "boat", code: "not_found", message: "Wrong account", retryable: false });
        retained.delete(sandboxId);
        return { status: "deleted" as const };
      },
    }) as unknown as Provider;
  const server = await harness({ providerFor }, await sharedDatabase());
  try {
    const { people: p, db } = server;
    await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'boat',$2)", [
      p.admin,
      await encryptSecret(adminKey, ENCRYPTION_KEY),
    ]);
    const token = await server.token(p.admin);
    const mcp = await server.client(token);
    const golden = (await db.query<{ id: string }>("select id from goldens where name='mine'")).rows[0];
    if (!golden) throw new Error("Missing private golden fixture.");
    const vault = createSqlVaultStore(db);
    const options: ControlOptions = {
      authStore: server.auth,
      store: vault,
      encryptionKey: ENCRYPTION_KEY,
      supabase: { supabaseUrl: "https://project.supabase.co", anonKey: "anon" },
      data: createSqlData(db),
      providers: providerRegistry({ vault, encryptionKey: ENCRYPTION_KEY, providerFor }),
    };
    for (const transport of ["api", "mcp"]) {
      const id = crypto.randomUUID();
      const providerId = `bx_private_${transport}`;
      await db.query(
        `insert into sandboxes(id,boat_id,golden_id,org_id,owner_id,harness,status,stopped_at)
        values($1,$2,$3,$4,$5,'claude','stopped',now())`,
        [id, providerId, golden.id, p.org, p.owner],
      );
      await db.query(
        "update sandboxes set status='ready',stopped_at=null,expires_at=now()+interval '1 minute' where id=$1",
        [id],
      );
      if (transport === "api") {
        const result = await handleControlRequest(
          new Request(`${PUBLIC_URL}/api/v1/sandbox/extend`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ id, ttl_seconds: 600 }),
          }),
          options,
        );
        expect(result?.status).toBe(200);
      } else expect((await call(mcp, "extend", { id, ttl_seconds: 600 })).isError).toBe(false);
      await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [id]);
      await db.query("insert into sandbox_work_recovery(sandbox_id,archive_enc) values($1,$2)", [
        id,
        new Uint8Array([1]),
      ]);
      if (transport === "api") {
        const result = await handleControlRequest(
          new Request(`${PUBLIC_URL}/api/v1/sandboxes/${id}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}` },
          }),
          options,
        );
        expect(result?.status).toBe(200);
      } else {
        const result = await call(mcp, "delete", { id });
        expect(result.isError).toBe(false);
      }
      expect(retained.has(providerId)).toBe(false);
      expect((await db.query("select status::text from sandboxes where id=$1", [id])).rows).toEqual([
        { status: "deleted" },
      ]);
      expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toEqual([]);
    }
    expect(accounts).toEqual(["owner", "owner", "owner", "owner"]);
  } finally {
    await server.close();
  }
});

// #2594: a confirmed Modal stop is deletable at once. Image cleanup retries transient
// failures in the request; a failure after proven exit releases the activity fence.
test("a stopped Modal sandbox deletes in one request, collects images before success and releases known-outcome fences", async () => {
  const server = await harness({}, await sharedDatabase());
  try {
    const { people: p, db } = server;
    const ownerToken = await server.token(p.owner);
    const binding = { workspace: "ws", environment: "main", appId: "ap-delete" };
    const scope: Scope = { orgId: p.org, userId: p.owner, visibility: "private", binding };
    const machine: Machine = {
      info: { id: "modal-logical", name: "worker", state: "stopped", providerState: "stopped", labels: {} },
      generation: 1,
      phase: "stopped",
      physicalId: "modal-physical",
      physicalName: "owned-worker",
      golden: false,
      ttlSeconds: 3600,
      managementAuthority: { credentialScope: "user", credentialOwnerId: p.owner },
      recoveryImageId: "recovery-image",
    };
    await createSqlModalStore(db, scope).reserve("modal-delete", machine);
    await db.query(
      `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
      values($1,$2,'delete-modal','private','modal','master','image',$3,$4,$5,'{"repos":[],"init":[]}')`,
      [p.org, p.owner, binding.workspace, binding.environment, binding.appId],
    );
    const id = crypto.randomUUID();
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,stopped_at)
      select $1,id,$2,$3,'modal',$4,'claude','stopped',now() from goldens where name='delete-modal'`,
      [id, p.org, p.owner, machine.info.id],
    );
    const sdk: string[] = [];
    let timeouts = 0,
      missingApps = 1;
    const timeout = (message: string) => Object.assign(Error(message), { name: "TimeoutError" });
    const client = {
      apps: {
        fromName: async () => {
          if (missingApps-- > 0) throw Object.assign(Error("app missing"), { name: "NotFoundError" });
          return { appId: binding.appId };
        },
      },
      sandboxes: {
        fromId: async () => {
          sdk.push("sandbox-lookup");
          throw Error("A confirmed stop must not reach the machine again.");
        },
      },
      images: {
        delete: async (imageId: string) => {
          if (timeouts-- > 0) throw timeout("image service timed out");
          sdk.push(`delete:${imageId}`);
        },
      },
    } as unknown as ModalClient;
    const retries: number[] = [];
    const vault = createSqlVaultStore(db);
    const options: ControlOptions = {
      authStore: server.auth,
      store: vault,
      encryptionKey: ENCRYPTION_KEY,
      supabase: { supabaseUrl: "https://project.supabase.co", anonKey: "anon" },
      data: createSqlData(db),
      providers: providerRegistry({
        vault,
        encryptionKey: ENCRYPTION_KEY,
        providerFor: () => {
          throw Error("Unexpected Boat fallback");
        },
        modalTokensFor: async () => ({ tokenId: "modal_id", tokenSecret: "modal_secret", scope: "user" }),
        modalProviderFor: async () => {
          return createModalProvider({
            scope,
            appName: "bound",
            client,
            store: createSqlModalStore(db, scope),
            distribution: {} as RunnerDistribution,
            runner: { call: async () => Promise.reject(Error("No runner call during deletion.")) },
            collectionSleep: async (milliseconds) => {
              retries.push(milliseconds);
            },
          });
        },
      }),
      now: () => server.clock.now,
    };
    const remove = () =>
      handleControlRequest(
        new Request(`${PUBLIC_URL}/api/v1/sandboxes/${id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${ownerToken}` },
        }),
        options,
      );
    const row = async () =>
      (
        await db.query<{ status: string; leased: boolean }>(
          "select status::text,coalesce(activity_until>=now(),false) as leased from sandboxes where id=$1",
          [id],
        )
      ).rows[0];
    const phase = async () => (await createSqlModalStore(db, scope).get(machine.info.id)).phase;
    const images = async () =>
      (await db.query("select name from modal_images where source_id=$1", [machine.info.id])).rows;
    // A refused admission logs its predicates from the refusing statement itself.
    await db.query("update sandboxes set activity_until=now()+interval '1 minute' where id=$1", [id]);
    const logged: string[] = [];
    const info = console.info;
    console.info = (line: string) => logged.push(line);
    try {
      expect((await remove())?.status).toBe(409);
    } finally {
      console.info = info;
    }
    expect(logged.map((line) => JSON.parse(line))).toEqual([
      {
        event: "sandbox_delete_admission_refused",
        sandboxId: id,
        observed: expect.objectContaining({ status: "stopped", activityLeaseHeld: true, reconcileLeaseHeld: false }),
      },
    ]);
    await db.query("update sandboxes set activity_until=null where id=$1", [id]);
    // A missing App is not proof the sandbox is gone: the row survives, the fence is released.
    expect((await remove())?.status).toBe(502);
    expect(await row()).toEqual({ status: "stopped", leased: false });
    expect(await phase()).toBe("stopped");
    // Collection that keeps failing fails the delete visibly, with physical exit proven,
    // so the fence is released and nothing reports success while images remain.
    timeouts = 3;
    expect((await remove())?.status).toBe(502);
    expect(await row()).toEqual({ status: "stopped", leased: false });
    expect(await phase()).toBe("deleted");
    expect(await images()).toHaveLength(1);
    expect(retries).toEqual([1_000, 5_000]);
    // A transient image timeout is retried inside the request: one DELETE completes.
    timeouts = 1;
    const response = await remove();
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ id, status: "deleted" });
    expect(await row()).toEqual({ status: "deleted", leased: false });
    expect(retries).toEqual([1_000, 5_000, 1_000]);
    expect(sdk).toEqual(["delete:recovery-image"]);
    expect(await images()).toEqual([]);
  } finally {
    await server.close();
  }
});

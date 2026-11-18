import { expect, spyOn, test } from "bun:test";
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
    const info = spyOn(console, "info");
    const providerFailure = await request(failed);
    expect(providerFailure.status).toBe(502);
    expect(await providerFailure.json()).toMatchObject({ error: { code: "provider_unavailable" } });
    expect((await state(failed)).status).toBe("failed");
    expect((await state(failed)).deleted_at).toBeNull();
    const retry = await request(failed);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: "sandbox_not_ready" } });
    // The refusal names the live lease from its own statement, and that lease names its writer.
    const events = info.mock.calls.flatMap(([line]) => {
      try {
        return [JSON.parse(String(line))];
      } catch {
        return [];
      }
    });
    info.mockRestore();
    const deleteAdmission = events.find((e) => e.event === "sandbox_activity_admitted" && e.sandboxId === failed);
    expect(deleteAdmission).toMatchObject({ kind: "delete", activityLeaseId: expect.any(String) });
    expect(events.find((e) => e.event === "sandbox_delete_admission_refused" && e.sandboxId === failed)).toEqual({
      event: "sandbox_delete_admission_refused",
      sandboxId: failed,
      observed: {
        status: "failed",
        activityLeaseId: deleteAdmission.activityLeaseId,
        activityLeaseHeld: true,
        reconcileLeaseHeld: false,
        stopRequested: false,
        generationChanged: false,
        managed: false,
      },
    });
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
        for (const ttl of [{ ttl_seconds: 600 }, { ttlSeconds: 900 }]) {
          const result = await handleControlRequest(
            new Request(`${PUBLIC_URL}/api/v1/sandbox/extend`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ id, ...ttl }),
            }),
            options,
          );
          expect(result?.status).toBe(200);
        }
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
        const result = await handleControlRequest(
          new Request(`${PUBLIC_URL}/api/v1/sandbox/delete`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ id }),
          }),
          options,
        );
        expect(result?.status).toBe(200);
      }
      expect(retained.has(providerId)).toBe(false);
      expect((await db.query("select status::text from sandboxes where id=$1", [id])).rows).toEqual([
        { status: "deleted" },
      ]);
      expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toEqual([]);
    }
    expect(accounts).toEqual(["owner", "owner", "owner", "owner", "owner"]);
  } finally {
    await server.close();
  }
});

// #2594: the HTTP stop writer leaves a Modal sandbox deletable by the very next request.
// Delete reuses the stop's exit proof instead of terminating again. A transient image
// timeout is retried inside the request; a persistent one, or a missing App, fails without
// publishing deletion and releases the server fence so the caller's retry is admitted at once.
test("a Modal sandbox stopped over HTTP is deleted by the next request, and failed deletes retry at once", async () => {
  const server = await harness({}, await sharedDatabase());
  try {
    const { people: p, db } = server;
    const ownerToken = await server.token(p.owner);
    const binding = { workspace: "ws", environment: "main", appId: "ap-delete" };
    const scope: Scope = { orgId: p.org, userId: p.owner, visibility: "private", binding };
    await db.query(
      `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
      values($1,$2,'delete-modal','private','modal','master','image',$3,$4,$5,'{"repos":[],"init":[]}')`,
      [p.org, p.owner, binding.workspace, binding.environment, binding.appId],
    );
    const sdk: string[] = [];
    let imageTimeouts = 0,
      missingApps = 0,
      appLookups = 0,
      missingAppAt = 0;
    const cleanupDelays: number[] = [];
    const detachedRuns: Promise<void>[] = [];
    let heldImage: { imageId: string; entered: () => void; released: Promise<void> } | undefined;
    const timeout = (message: string) => Object.assign(Error(message), { name: "TimeoutError" });
    const exited = new Set<string>();
    const client = {
      apps: {
        fromName: async () => {
          if (missingApps-- > 0 || ++appLookups === missingAppAt)
            throw Object.assign(Error("app missing"), { name: "NotFoundError" });
          return { appId: binding.appId };
        },
      },
      sandboxes: {
        fromId: async (physicalId: string) => ({
          snapshotFilesystem: async () => {
            sdk.push(`snapshot:${physicalId}`);
            return { imageId: `recovery-${physicalId}` };
          },
          terminate: async () => {
            if (exited.has(physicalId)) throw Error("A confirmed stop must not be terminated again.");
            sdk.push(`terminate:${physicalId}`);
            exited.add(physicalId);
          },
          poll: async () => (exited.has(physicalId) ? 0 : null),
        }),
      },
      images: {
        delete: async (imageId: string) => {
          if (imageId === heldImage?.imageId) {
            heldImage.entered();
            await heldImage.released;
          }
          if (imageTimeouts-- > 0) throw timeout("image service timed out");
          sdk.push(`delete:${imageId}`);
        },
      },
    } as unknown as ModalClient;
    const vault = createSqlVaultStore(db);
    const modalProvider = () =>
      createModalProvider({
        scope,
        appName: "bound",
        client,
        store: createSqlModalStore(db, scope),
        distribution: { capabilities: {}, prepareSnapshot: async () => {} } as unknown as RunnerDistribution,
        runner: {
          call: async <T>(_row: Machine, op: string) =>
            (op === "checkpoint" ? { generation: "1", watermark: 0, acknowledgedSequence: 0 } : {}) as T,
        },
        cleanupSleep: async (milliseconds) => {
          cleanupDelays.push(milliseconds);
        },
        // Detached as in production; the test keeps each run only to settle it before teardown.
        detachCollection: (work) => {
          detachedRuns.push(work());
        },
      });
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
        modalProviderFor: async () => modalProvider(),
      }),
      now: () => server.clock.now,
    };
    const launch = async (name: string, lostCreate = false) => {
      const machine: Machine = {
        info: { id: `modal-${name}`, name, state: "running", providerState: "active", labels: {} },
        generation: 1,
        phase: "active",
        physicalId: `physical-${name}`,
        physicalName: `owned-${name}`,
        golden: false,
        ttlSeconds: 3600,
        managementAuthority: { credentialScope: "user", credentialOwnerId: p.owner },
        recoveryImageId: `prior-${name}`,
      };
      if (lostCreate) {
        // The create response was lost: the outcome is unknown and no physical ID is recorded.
        machine.phase = "creating";
        machine.info.state = "starting";
        delete machine.physicalId;
        delete machine.recoveryImageId;
      }
      await createSqlModalStore(db, scope).reserve(`request-${name}`, machine);
      const id = crypto.randomUUID();
      await db.query(
        `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
        select $1,id,$2,$3,'modal',$4,'claude',$5 from goldens where name='delete-modal'`,
        [id, p.org, p.owner, machine.info.id, lostCreate ? "failed" : "running"],
      );
      return { id, machine: machine.info.id };
    };
    const control = async (path: string, method: string, body?: object) => {
      const response = await handleControlRequest(
        new Request(`${PUBLIC_URL}/api/v1/${path}`, {
          method,
          headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        options,
      );
      if (!response) throw Error(`Missing route ${path}.`);
      return response;
    };
    const row = async (id: string) =>
      (
        await db.query<{ status: string; leased: boolean }>(
          "select status::text,coalesce(activity_until>=now(),false) as leased from sandboxes where id=$1",
          [id],
        )
      ).rows[0];
    const phase = async (machine: string) => (await createSqlModalStore(db, scope).get(machine)).phase;

    const first = await launch("first");
    const stopped = await control("sandbox/stop", "POST", { id: first.id });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ id: first.id, status: "stopped" });
    expect(await row(first.id)).toEqual({ status: "stopped", leased: false });
    const deleted = await control(`sandboxes/${first.id}`, "DELETE");
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id: first.id, status: "deleted" });
    expect(await row(first.id)).toEqual({ status: "deleted", leased: false });
    expect(await phase(first.machine)).toBe("deleted");
    expect(sdk.filter((x) => x.startsWith("terminate:"))).toEqual(["terminate:physical-first"]);
    expect(sdk.filter((x) => x.startsWith("delete:")).toSorted()).toEqual([
      "delete:prior-first",
      "delete:recovery-physical-first",
    ]);

    const second = await launch("second");
    expect((await control("sandbox/stop", "POST", { id: second.id })).status).toBe(200);
    // A missing App is not proof the sandbox is gone: nothing is published or written.
    missingApps = 1;
    expect((await control(`sandboxes/${second.id}`, "DELETE")).status).toBeGreaterThanOrEqual(500);
    expect(await row(second.id)).toEqual({ status: "stopped", leased: false });
    expect(await phase(second.machine)).toBe("stopped");
    imageTimeouts = 3;
    const failed = await control(`sandboxes/${second.id}`, "DELETE");
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(cleanupDelays).toEqual([1_000, 5_000]);
    // The adapter's deleting phase fences resume; the server lease no longer refuses the retry.
    expect(await row(second.id)).toEqual({ status: "stopped", leased: false });
    expect(await phase(second.machine)).toBe("deleting");
    const retried = await control(`sandboxes/${second.id}`, "DELETE");
    expect(retried.status).toBe(200);
    expect(await row(second.id)).toEqual({ status: "deleted", leased: false });
    expect(await phase(second.machine)).toBe("deleted");
    expect(sdk.filter((x) => x === "terminate:physical-second")).toHaveLength(1);

    // One transient image timeout no longer costs the caller a second DELETE.
    const third = await launch("third");
    expect((await control("sandbox/stop", "POST", { id: third.id })).status).toBe(200);
    imageTimeouts = 1;
    expect((await control(`sandboxes/${third.id}`, "DELETE")).status).toBe(200);
    expect(await row(third.id)).toEqual({ status: "deleted", leased: false });
    expect(cleanupDelays).toEqual([1_000, 5_000, 1_000]);
    expect(sdk.filter((x) => x.endsWith("-third")).toSorted()).toEqual([
      "delete:prior-third",
      "delete:recovery-physical-third",
      "snapshot:physical-third",
      "terminate:physical-third",
    ]);

    // Name reconciliation of a lost create looks the App up again. A missing App there says
    // nothing about the machine: both records stay recoverable and nothing is published.
    const lost = await launch("lost", true);
    missingAppAt = appLookups + 2;
    expect((await control(`sandboxes/${lost.id}`, "DELETE")).status).toBeGreaterThanOrEqual(500);
    expect(appLookups).toBe(missingAppAt);
    expect(await row(lost.id)).toEqual({ status: "failed", leased: false });
    expect(await phase(lost.machine)).toBe("creating");
    expect(sdk.filter((x) => x.endsWith("-lost"))).toEqual([]);

    // Another source's retired image is collected detached. While its image call is held open,
    // the target's DELETE still answers 200 and releases its activity lease (the proof that a
    // repeated DELETE is never refused with 409 sandbox_not_ready).
    await Promise.all(detachedRuns.splice(0));
    const modalStore = createSqlModalStore(db, scope);
    const retired = await launch("retired-source");
    await modalStore.saveImage({
      info: { name: "retired-elsewhere", status: "ready", createdAt: new Date() },
      sourceId: retired.machine,
      imageId: "retired-elsewhere",
      managementAuthority: { credentialScope: "user", credentialOwnerId: p.owner },
    });
    await modalStore.removeImage("retired-elsewhere");
    expect(await modalStore.tombstoneSources()).toContain(retired.machine);
    const target = await launch("target");
    expect((await control("sandbox/stop", "POST", { id: target.id })).status).toBe(200);
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    heldImage = { imageId: "retired-elsewhere", entered: entered.resolve, released: released.promise };
    const receipt = await control(`sandboxes/${target.id}`, "DELETE");
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toEqual({ id: target.id, status: "deleted" });
    await entered.promise;
    expect(await row(target.id)).toEqual({ status: "deleted", leased: false });
    expect(await phase(target.machine)).toBe("deleted");
    expect((await control(`sandboxes/${target.id}`, "DELETE")).status).toBe(200);
    expect(sdk).not.toContain("delete:retired-elsewhere");
    released.resolve();
    await Promise.all(detachedRuns.splice(0));
    expect(sdk).toContain("delete:retired-elsewhere");
    expect(await modalStore.tombstoneSources()).not.toContain(retired.machine);
  } finally {
    await server.close();
  }
});

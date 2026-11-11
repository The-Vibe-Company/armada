import { expect, test } from "bun:test";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { encryptSecret } from "../src/crypto.ts";
import { GoldenBuildJobs } from "../src/golden-build-jobs.ts";
import { createSqlGoldenStore } from "../src/golden-store.ts";
import type { Provider } from "../src/provider.ts";
import type { ModalBinding, ProviderTarget } from "../src/sandbox-provider.ts";
import { createSqlVaultStore } from "../src/vault-store.ts";
import { goldenHelperReport } from "./support/golden-helper.ts";

const key = Buffer.alloc(32, 37).toString("base64");
const binding: ModalBinding = { workspace: "verified-workspace", environment: "production", appId: "ap_pinned" };

/** Actual queue/transactions/vault and service; only GitHub HTTP and the remote VM provider are synthetic. */
async function fixture() {
  const db = await openDatabase();
  await applyMigrations(db);
  const userId = crypto.randomUUID(),
    orgId = crypto.randomUUID(),
    admin = crypto.randomUUID();
  await db.query("insert into auth.users(id) values($1),($2)", [userId, admin]);
  await db.query("insert into orgs(id,name) values($1,'Modal builds')", [orgId]);
  await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'admin')", [
    orgId,
    userId,
    admin,
  ]);
  await db.query(
    "insert into github_connections(user_id,github_id,login,refresh_token_enc) values($1,77,'builder',$2)",
    [userId, await encryptSecret("fixture-refresh", key)],
  );
  const actor = { userId, orgId, role: "admin" as const };
  const input = { name: "modal-web", visibility: "org" as const, repos: ["acme/web"], modal: binding };
  let allocations = 0,
    connectionRevision = 1;
  let checkout: (() => Promise<void>) | undefined;
  let snapshot: (() => Promise<void>) | undefined;
  const contexts: ProviderTarget[] = [],
    allocatedWith: number[] = [],
    deleted: string[] = [];
  const builders = new Map<string, string>();
  const provider = (revision: number): Provider =>
    ({
      id: "modal",
      createGolden: async (request) => {
        allocations++;
        allocatedWith.push(revision);
        if (request.idempotencyKey) builders.set(request.idempotencyKey, `modal-builder-${allocations}`);
        return {
          id: `modal-builder-${allocations}`,
          name: "builder",
          state: "ready",
          providerState: "active",
          labels: {},
        };
      },
      snapshot: async ({ name, sandboxId }) => {
        await snapshot?.();
        return { name, status: "ready", sourceSandboxId: sandboxId };
      },
      getSnapshot: async (name) => ({ name, status: "ready" }),
      deleteSnapshot: async () => {},
      exec: async ({ command }) => ({
        detached: false,
        exitCode: 0,
        stdout: command.includes("/helper/0.1.0/armada-helper") ? goldenHelperReport : "",
        stderr: "",
        timedOut: false,
        truncated: false,
      }),
      findGoldenBuilder: async ({ requestKey }) => {
        const id = builders.get(requestKey);
        return id ? { sandboxId: id, disposition: "disposable" } : null;
      },
      disposeGoldenBuilder: async ({ sandboxId }) => {
        deleted.push(sandboxId);
        return { status: "deleted" };
      },
      delete: async ({ sandboxId }) => {
        deleted.push(sandboxId);
        return { status: "deleted" };
      },
      stop: async () => {
        throw new Error("A Modal builder must not create a stop checkpoint.");
      },
    }) satisfies Pick<
      Provider,
      | "id"
      | "createGolden"
      | "findGoldenBuilder"
      | "disposeGoldenBuilder"
      | "snapshot"
      | "getSnapshot"
      | "deleteSnapshot"
      | "exec"
      | "delete"
      | "stop"
    > as unknown as Provider;
  const fetchGitHub = (async (request: string | URL | Request) => {
    const url = String(request);
    if (url === "https://github.com/login/oauth/access_token")
      return Response.json({
        access_token: "fixture-github-access",
        refresh_token: "fixture-next-refresh",
        expires_in: 28800,
        refresh_token_expires_in: 31536000,
      });
    if (url === "https://api.github.com/user") return Response.json({ id: 77, login: "builder", name: null });
    if (url.includes("/user/installations")) return Response.json({ installations: [] });
    if (url === "https://api.github.com/repos/acme/web")
      return Response.json({ id: 1, name: "web", owner: { login: "acme" }, default_branch: "main", private: false });
    throw new Error("Unexpected fixture GitHub route.");
  }) as typeof fetch;
  const jobs = new GoldenBuildJobs({
    sql: db,
    encryptionKey: key,
    service: {
      github: {
        store: createSqlVaultStore(db),
        encryptionKey: key,
        app: { clientId: "fixture", clientSecret: "fixture" },
        fetch: fetchGitHub,
      },
      installationApp: null,
      fetch: fetchGitHub,
      ssh: async () => {
        await checkout?.();
      },
    },
    provider: async (_actor, _visibility, target) => {
      contexts.push(structuredClone(target));
      return provider(connectionRevision);
    },
  });
  return {
    db,
    actor,
    input,
    jobs,
    contexts,
    allocatedWith,
    deleted,
    provider: provider(0),
    allocations: () => allocations,
    rotate: () => {
      connectionRevision++;
    },
    checkout: (fn: () => Promise<void>) => {
      checkout = fn;
    },
    snapshot: (fn: () => Promise<void>) => {
      snapshot = fn;
    },
  };
}

// New owner risk: unbounded Modal uses the same durable publication protocol without fabricating a Boat slot.
test("Modal admission seals pinned context, allocates only after commit, and publishes job plus golden atomically without a slot", async () => {
  const f = await fixture();
  try {
    const setup = "echo fixture-encrypted-setup";
    const idempotency = crypto.randomUUID();
    const queued = await f.jobs.admit(f.provider, f.actor, { ...f.input, setup }, idempotency);
    expect(queued).toMatchObject({ provider: "modal", state: "queued", result: null });
    expect(f.allocations()).toBe(0);
    expect((await f.jobs.admit(f.provider, f.actor, { ...f.input, setup }, idempotency)).jobId).toBe(queued.jobId);
    await expect(
      f.jobs.admit(f.provider, f.actor, { ...f.input, modal: { ...binding, appId: "ap_other" }, setup }, idempotency),
    ).rejects.toMatchObject({ code: "conflict" });
    const stored = (
      await f.db.query<{ provider: string; reservation_id: string | null; payload_enc: Uint8Array }>(
        "select provider,reservation_id,payload_enc from golden_build_jobs where id=$1",
        [queued.jobId],
      )
    ).rows[0]!;
    expect(stored.provider).toBe("modal");
    expect(stored.reservation_id).toBeNull();
    expect(Buffer.from(stored.payload_enc).includes(Buffer.from(setup))).toBe(false);
    expect(Buffer.from(stored.payload_enc).includes(Buffer.from(binding.appId))).toBe(false);
    expect((await f.db.query("select 1 from golden_backend_slots")).rows).toEqual([]);
    f.rotate();
    expect(await f.jobs.runOne()).toBe(true);
    expect(await f.jobs.status(f.actor.userId, queued.jobId)).toMatchObject({
      state: "succeeded",
      provider: "modal",
      result: { name: f.input.name },
    });
    expect(f.allocatedWith).toEqual([2]);
    expect(f.contexts).toEqual(
      Array(2).fill({
        provider: "modal",
        orgId: f.actor.orgId,
        visibility: "org",
        sourceGoldenVisibility: "org",
        modal: binding,
      }),
    );
    const saved = (await createSqlGoldenStore(f.db).findByName(f.actor.orgId, f.input.name))[0]!;
    expect(saved).toMatchObject({ provider: "modal", modal: binding, providerSandboxId: null });
    expect(saved.providerSnapshotId).toBeTruthy();
    expect(
      (await f.db.query("select boat_sandbox_id,boat_snapshot_id from goldens where id=$1", [saved.id])).rows,
    ).toEqual([{ boat_sandbox_id: null, boat_snapshot_id: null }]);
    expect((await f.db.query("select 1 from golden_backend_slots")).rows).toEqual([]);
    await expect(
      f.db.query("update golden_build_jobs set provider='boat',reservation_id=$2 where id=$1", [
        queued.jobId,
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow("immutable");
    // A publication failure after inserting a golden must roll that insert back together with job success.
    await f.db.exec(
      "create function reject_modal_success() returns trigger language plpgsql as $$ begin if new.state='succeeded' then raise exception 'fixture publication failure'; end if; return new; end $$; create trigger reject_modal_success before update on golden_build_jobs for each row execute function reject_modal_success();",
    );
    const failed = await f.jobs.admit(f.provider, f.actor, { ...f.input, name: "rollback" }, crypto.randomUUID());
    await f.jobs.runOne();
    expect((await f.jobs.status(f.actor.userId, failed.jobId)).state).toBe("failed");
    expect((await f.db.query("select 1 from goldens where name='rollback'")).rows).toEqual([]);
    expect((await f.db.query("select 1 from golden_backend_slots")).rows).toEqual([]);
  } finally {
    await f.db.close();
  }
});

test("Modal queued authority is rechecked and a lost worker fence cannot publish or replay its builder without a slot", async () => {
  const f = await fixture();
  let release = () => {};
  let worker: Promise<boolean> | undefined;
  try {
    await expect(
      f.jobs.admit(
        f.provider,
        f.actor,
        { name: f.input.name, visibility: f.input.visibility, repos: f.input.repos },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(f.contexts).toEqual([]);
    const revoked = await f.jobs.admit(f.provider, f.actor, f.input, crypto.randomUUID());
    await f.db.query("update members set role='member' where org_id=$1 and user_id=$2", [
      f.actor.orgId,
      f.actor.userId,
    ]);
    await f.jobs.runOne();
    expect((await f.jobs.status(f.actor.userId, revoked.jobId)).state).toBe("failed");
    expect(f.allocations()).toBe(0);
    await f.db.query("update members set role='admin' where org_id=$1 and user_id=$2", [f.actor.orgId, f.actor.userId]);
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.checkout(async () => {
      entered();
      await blocked;
    });
    const fenced = await f.jobs.admit(f.provider, f.actor, { ...f.input, name: "fenced" }, crypto.randomUUID());
    worker = f.jobs.runOne();
    await started;
    await f.db.query("update golden_build_jobs set lease_until=now()-interval '1 second' where id=$1", [fenced.jobId]);
    expect(await f.jobs.runOne()).toBe(false);
    expect((await f.jobs.status(f.actor.userId, fenced.jobId)).state).toBe("recovery_required");
    release();
    await worker;
    expect((await f.db.query("select 1 from goldens where name='fenced'")).rows).toEqual([]);
    f.rotate();
    await f.jobs.reconcileOne();
    expect((await f.jobs.status(f.actor.userId, fenced.jobId)).state).toBe("failed");
    expect(await f.jobs.runOne()).toBe(false);
    expect(f.allocations()).toBe(1);
    expect(f.deleted.length).toBeGreaterThan(0);
    expect(f.contexts.at(-1)?.modal).toEqual(binding);
  } finally {
    release();
    await worker;
    await f.db.close();
  }
});

test("an unknown Modal snapshot preserves its original source and pinned context for reconciliation without replay", async () => {
  const f = await fixture();
  try {
    f.snapshot(async () => {
      throw new Error("fixture lost remote snapshot response");
    });
    const job = await f.jobs.admit(f.provider, f.actor, f.input, crypto.randomUUID());
    await f.jobs.runOne();
    expect(await f.jobs.status(f.actor.userId, job.jobId)).toMatchObject({
      state: "recovery_required",
      phase: "snapshot",
    });
    expect(f.deleted).toEqual([]);
    f.rotate();
    await f.jobs.reconcileOne();
    expect((await f.jobs.status(f.actor.userId, job.jobId)).state).toBe("recovery_required");
    expect(f.contexts.at(-1)?.modal).toEqual(binding);
    expect(f.deleted).toEqual([]);
    expect(await f.jobs.runOne()).toBe(false);
    expect(f.allocations()).toBe(1);
    expect((await f.db.query("select 1 from goldens")).rows).toEqual([]);
  } finally {
    await f.db.close();
  }
});

test("an older retained recovery queue head does not starve an interrupted builder", async () => {
  const f = await fixture();
  try {
    const retained = await f.jobs.admit(
      f.provider,
      f.actor,
      { ...f.input, name: "retained-source" },
      crypto.randomUUID(),
    );
    const recoverable = await f.jobs.admit(
      f.provider,
      f.actor,
      { ...f.input, name: "recoverable-source" },
      crypto.randomUUID(),
    );
    const builder = await f.provider.createGolden({ idempotencyKey: recoverable.jobId });
    await f.db.query(
      "update golden_build_jobs set state='recovery_required',error_code='build_failed',fence=$2,phase='snapshot',builder_id='retained-builder',updated_at='2000-01-01' where id=$1",
      [retained.jobId, crypto.randomUUID()],
    );
    await f.db.query(
      "update golden_build_jobs set state='recovery_required',error_code='build_failed',fence=$2,phase='builder',updated_at='2001-01-01' where id=$1",
      [recoverable.jobId, crypto.randomUUID()],
    );
    await f.jobs.reconcileOne();
    await f.jobs.reconcileOne();
    expect(await f.jobs.status(f.actor.userId, retained.jobId)).toMatchObject({
      state: "recovery_required",
      phase: "snapshot",
    });
    expect(await f.jobs.status(f.actor.userId, recoverable.jobId)).toMatchObject({ state: "failed", phase: "builder" });
    expect(f.deleted).toEqual([builder.id]);
    expect(f.allocations()).toBe(1);
  } finally {
    await f.db.close();
  }
});

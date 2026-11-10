import { expect, spyOn, test } from "bun:test";
import { createSqlGoldenStore, createSqlVaultStore, type GoldenBuildStatus, ProviderError } from "@armada/core/server";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { call, ENCRYPTION_KEY, harness, PUBLIC_URL, type TestServer } from "./support.ts";

async function fixture() {
  const server = await harness();
  const { boat, people } = server;
  let allocations = 0;
  boat.provider.createGolden = async () => {
    allocations++;
    return boat.provider.fork({ from: "blank" });
  };
  const snapshots = new Map<string, { name: string; status: "ready"; sourceSandboxId: string }>();
  boat.provider.snapshot = async ({ name, sandboxId }) => {
    const info = { name, status: "ready" as const, sourceSandboxId: sandboxId };
    snapshots.set(name, info);
    return info;
  };
  boat.provider.getSnapshot = async (name) => {
    const info = snapshots.get(name);
    if (!info)
      throw new ProviderError({ provider: "boat", code: "not_found", message: "absent snapshot", retryable: false });
    return info;
  };
  const deleted: string[] = [];
  boat.provider.deleteSnapshot = async (name) => {
    deleted.push(name);
  };
  await server.github.connect(people.admin, "admin", 101);
  await server.github.connect(people.owner, "owner", 102);
  const control = {
    authStore: server.auth,
    supabase: { supabaseUrl: "https://unused.test", anonKey: "test" },
    store: createSqlVaultStore(server.db),
    encryptionKey: ENCRYPTION_KEY,
    data: createSqlData(server.db),
    providerFor: boat.providerFor,
    goldenBuilds: server.builds,
  };
  const http = async (token: string, route: string, body: object) =>
    (await handleControlRequest(
      new Request(PUBLIC_URL + "/api/v1/" + route, {
        method: "POST",
        headers: { authorization: "Bearer " + token },
        body: JSON.stringify(body),
      }),
      control,
    ))!;
  return { ...server, http, deleted, allocations: () => allocations };
}

test("HTTP durable admission, idempotent acknowledgement recovery and MCP status outlive the request", async () => {
  const s = await fixture();
  try {
    const token = await s.token(s.people.admin);
    const body = { name: "async-web", org: s.people.org, repos: ["acme/web"], idempotencyKey: crypto.randomUUID() };
    const response = await s.http(token, "golden/create", body);
    expect(response.status).toBe(202);
    const job = (await response.json()) as GoldenBuildStatus;
    expect(job.state).toBe("queued");
    expect(
      (await s.db.query("select expected_snapshot_id,revision_known from golden_build_jobs where id=$1", [job.jobId]))
        .rows,
    ).toEqual([{ expected_snapshot_id: null, revision_known: true }]);
    expect(s.allocations()).toBe(0);
    expect((await s.db.query("select 1 from golden_build_jobs")).rows).toHaveLength(1);
    const replay = await s.http(token, "golden/create", body);
    expect(await replay.json()).toEqual(job);
    const conflict = await s.http(token, "golden/create", { ...body, name: "different" });
    expect(conflict.status).toBe(409);
    const recover = await s.http(token, "golden/build/status", {
      org: s.people.org,
      idempotencyKey: body.idempotencyKey,
    });
    expect(await recover.json()).toEqual(job);
    const client = await s.client(token);
    expect((await call(client, "golden_build_status", { jobId: job.jobId })).data).toMatchObject({ state: "queued" });
    // The original HTTP response is already consumed. A separately scheduled worker owns execution.
    expect(await s.builds.runOne()).toBe(true);
    const done = await s.http(token, "golden/build/status", { jobId: job.jobId });
    const result = (await done.json()) as GoldenBuildStatus;
    expect(result).toMatchObject({ state: "succeeded", errorCode: null, result: { name: body.name } });
    expect(s.allocations()).toBe(1);
    const row = (await s.db.query("select provider_snapshot_id,config from goldens where name=$1", [body.name]))
      .rows[0];
    expect(row).toMatchObject({ provider_snapshot_id: result.result!.snapshot, config: { repos: [{ dir: "web" }] } });
    expect((await s.db.query("select build_id from golden_backend_slots")).rows).toEqual([{ build_id: null }]);
    expect(await (await s.http(token, "golden/create", body)).json()).toEqual(result);
    const member = await s.token(s.people.member);
    expect((await s.http(member, "golden/build/status", { jobId: job.jobId })).status).toBe(200);
    await s.db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [s.people.admin]);
      await tx.query("select set_golden_visibility(id,'private') from goldens where name=$1", [body.name]);
    });
    expect((await s.http(member, "golden/build/status", { jobId: job.jobId })).status).toBe(404);
  } finally {
    await s.close();
  }
});

test("MCP admission and rebuild failure retain last-good config/pointer and release only the build reservation", async () => {
  const s = await fixture();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    const token = await s.token(s.people.admin);
    const client = await s.client(token);
    const created = await call(client, "golden_create", {
      name: "retained",
      org: s.people.org,
      repos: ["acme/web"],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(created.isError).toBe(false);
    const id = (created.data as unknown as GoldenBuildStatus).jobId;
    await s.builds.runOne();
    expect((await s.builds.status(s.people.admin, id)).state).toBe("succeeded");
    const before = (await s.db.query("select * from goldens where name='retained'")).rows[0];
    // Keep the CHECK enforced; neither store writes nor publication may need a repair trigger.
    await s.db.exec("alter table goldens disable trigger goldens_provider_guard");
    const master = await s.boat.provider.fork({
      from: (before as { provider_snapshot_id: string }).provider_snapshot_id,
      noEnv: true,
    });
    await createSqlGoldenStore(s.db).setSandbox((before as { id: string }).id, master.id);
    const retained = (await s.db.query("select * from goldens where name='retained'")).rows[0];
    expect(retained).toMatchObject({
      boat_sandbox_id: master.id,
      provider_sandbox_id: master.id,
      boat_snapshot_id: (before as { provider_snapshot_id: string }).provider_snapshot_id,
      provider_snapshot_id: (before as { provider_snapshot_id: string }).provider_snapshot_id,
    });
    await expect(
      s.db.query("update goldens set provider_sandbox_id='desynced' where id=$1", [(before as { id: string }).id]),
    ).rejects.toMatchObject({ code: "23514" });
    for (const failure of ["secret_scan", "pointer", "persist", "lease"]) {
      logs.mockClear();
      const phase = failure === "secret_scan" ? "secret_scan" : "persist";
      s.boat.setExecOutput({ exitCode: phase === "secret_scan" ? 97 : 0 });
      if (failure === "pointer")
        await s.db.exec(`create function fail_snapshot_pointer() returns trigger language plpgsql as $$
        begin raise exception 'private-error-detail-not-for-logs' using errcode='23514'; end $$;
        create trigger fail_snapshot_pointer before update of provider_snapshot_id on goldens for each row execute function fail_snapshot_pointer();`);
      if (failure === "persist")
        await s.db.exec(`create function fail_job_success() returns trigger language plpgsql as $$
        begin if new.state='succeeded' then raise exception 'injected job commit failure'; end if; return new; end $$;
        create trigger fail_job_success before update on golden_build_jobs for each row execute function fail_job_success();`);
      if (failure === "lease")
        await s.db.exec(`create function expire_job_lease() returns trigger language plpgsql as $$
        begin update golden_build_jobs set lease_until=clock_timestamp()-interval '1 second' where state='running'; return new; end $$;
        create trigger expire_job_lease before update of config on goldens for each row execute function expire_job_lease();`);
      const admitted = await s.http(token, "golden/update", {
        name: "retained",
        org: s.people.org,
        idempotencyKey: crypto.randomUUID(),
        config: { repos: [{ url: "https://github.com/acme/web.git", branch: "changed" }], init: ["false"] },
      });
      expect(admitted.status).toBe(202);
      const job = (await admitted.json()) as GoldenBuildStatus;
      expect(
        (await s.db.query("select expected_snapshot_id,revision_known from golden_build_jobs where id=$1", [job.jobId]))
          .rows,
      ).toEqual([
        {
          expected_snapshot_id: (before as { provider_snapshot_id: string }).provider_snapshot_id,
          revision_known: true,
        },
      ]);
      await s.builds.runOne();
      expect(await s.builds.status(s.people.admin, job.jobId)).toMatchObject({
        state: "failed",
        phase,
        errorCode: "build_failed",
        result: null,
      });
      expect((await s.db.query("select * from goldens where name='retained'")).rows[0]).toEqual(retained);
      const diagnostics = logs.mock.calls.map(([line]) => JSON.parse(String(line)));
      const publication = diagnostics.filter((entry) => entry.event === "golden_persist_failed");
      if (failure === "pointer" || failure === "persist")
        expect(publication).toEqual([
          {
            event: "golden_persist_failed",
            buildId: job.jobId,
            step: failure === "pointer" ? "snapshot_pointer" : "job_complete",
            sqlState: failure === "pointer" ? "23514" : "P0001",
          },
        ]);
      expect(JSON.stringify(diagnostics)).not.toContain("private-error-detail-not-for-logs");
      expect(JSON.stringify(diagnostics)).not.toContain("injected job commit failure");
      expect((await s.db.query("select snapshot from golden_build_jobs where id=$1", [job.jobId])).rows).toEqual([
        { snapshot: null },
      ]);
      if (failure === "pointer")
        await s.db.exec("drop trigger fail_snapshot_pointer on goldens; drop function fail_snapshot_pointer();");
      expect((await s.db.query("select golden_id,build_id from golden_backend_slots")).rows).toEqual([
        { golden_id: (before as { id: string }).id, build_id: null },
      ]);
      expect((await s.builds.status(s.people.admin, job.jobId)).phase).toBe(phase);
      expect(s.boat.execs.at(-1)?.timeoutSeconds).toBe(600);
      expect(s.deleted).not.toContain((before as { provider_snapshot_id: string }).provider_snapshot_id);
      expect((await s.db.query("select id from golden_snapshot_retirements")).rows).toEqual([]);
      if (failure === "persist")
        await s.db.exec("drop trigger fail_job_success on golden_build_jobs; drop function fail_job_success();");
    }
    await s.db.exec("drop trigger expire_job_lease on goldens; drop function expire_job_lease();");
    const response = await s.http(token, "golden/update", {
      name: "retained",
      org: s.people.org,
      idempotencyKey: crypto.randomUUID(),
      config: { repos: [{ url: "https://github.com/acme/web.git", branch: "published" }], init: [] },
    });
    expect(response.status).toBe(202);
    const publishedJob = (await response.json()) as GoldenBuildStatus;
    await s.builds.runOne();
    const published = await s.builds.status(s.people.admin, publishedJob.jobId);
    expect(published).toMatchObject({ state: "succeeded", phase: "complete", errorCode: null });
    expect(
      (
        await s.db.query(
          "select r.old_snapshot,r.new_snapshot,j.state as job_state from golden_snapshot_retirements r join golden_build_jobs j on j.id=$1 where r.golden_id=j.golden_id",
          [publishedJob.jobId],
        )
      ).rows,
    ).toEqual([
      {
        old_snapshot: (before as { provider_snapshot_id: string }).provider_snapshot_id,
        new_snapshot: published.result!.snapshot,
        job_state: "succeeded",
      },
    ]);
    expect(published.result!.snapshot).not.toBe((before as { provider_snapshot_id: string }).provider_snapshot_id);
    expect(
      (
        await s.db.query(
          "select boat_sandbox_id,provider_sandbox_id,boat_snapshot_id,provider_snapshot_id from goldens where name='retained'",
        )
      ).rows,
    ).toEqual([
      {
        boat_sandbox_id: null,
        provider_sandbox_id: null,
        boat_snapshot_id: published.result!.snapshot,
        provider_snapshot_id: published.result!.snapshot,
      },
    ]);
    await expect(
      s.db.query("update goldens set boat_snapshot_id='desynced' where id=$1", [(before as { id: string }).id]),
    ).rejects.toMatchObject({ code: "23514" });
  } finally {
    logs.mockRestore();
    await s.close();
  }
});

test("authorization denials allocate no work; private status is owner-only; capacity stays reserved while queued", async () => {
  const s = await fixture();
  try {
    const member = await s.token(s.people.member);
    const owner = await s.token(s.people.owner);
    const admin = await s.token(s.people.admin);
    const body = { name: "private-build", org: s.people.org, repos: ["acme/web"], idempotencyKey: crypto.randomUUID() };
    expect((await s.http("", "golden/create", body)).status).toBe(401);
    expect((await s.http(member, "golden/create", body)).status).toBe(403);
    const deniedMcp = await call(await s.client(member), "golden_create", body);
    expect(deniedMcp.isError).toBe(true);
    expect((await s.db.query("select 1 from golden_build_jobs")).rows).toEqual([]);
    expect(s.boat.keys).toEqual([]);
    const admitted = await s.http(owner, "golden/create", { ...body, private: true });
    const job = (await admitted.json()) as GoldenBuildStatus;
    expect(admitted.status).toBe(202);
    await s.db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [
      s.people.otherOrg,
      s.people.owner,
    ]);
    const otherScope = await s.token(s.people.owner, s.people.otherOrg);
    expect((await s.http(otherScope, "golden/build/status", { jobId: job.jobId })).status).toBe(404);
    expect((await call(await s.client(otherScope), "golden_build_status", { jobId: job.jobId })).isError).toBe(true);
    expect((await s.http(admin, "golden/build/status", { jobId: job.jobId })).status).toBe(404);
    expect((await s.http(member, "golden/build/status", { jobId: job.jobId })).status).toBe(404);
    expect((await s.http(admin, "golden/create", { ...body, idempotencyKey: crypto.randomUUID() })).status).toBe(409);
    expect(s.allocations()).toBe(0);
    // Admission never grants continued execution rights after membership revocation.
    await s.db.query("delete from members where user_id=$1 and org_id=$2", [s.people.owner, s.people.org]);
    expect((await s.http(owner, "golden/build/status", { jobId: job.jobId })).status).toBe(404);
    await s.builds.runOne();
    expect(s.allocations()).toBe(0);
    expect((await s.db.query("select state from golden_build_jobs")).rows).toEqual([{ state: "failed" }]);
    expect((await s.db.query("select 1 from golden_backend_slots")).rows).toEqual([]);
  } finally {
    await s.close();
  }
});

test("expired execution fence cannot publish or replay; reconciliation stops a known builder and retains last good", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let worker: Promise<boolean> | undefined;
  const base: TestServer = await harness({
    buildSsh: async () => {
      entered();
      await gate;
    },
  });
  try {
    let allocations = 0;
    base.boat.provider.createGolden = async () => {
      allocations++;
      return base.boat.provider.fork({ from: "blank" });
    };
    await base.github.connect(base.people.admin, "admin", 103);
    const actor = { userId: base.people.admin, orgId: base.people.org, role: "admin" as const };
    const job = await base.builds.admit(
      base.boat.provider,
      actor,
      { name: "expired", visibility: "org", repos: ["acme/web"] },
      crypto.randomUUID(),
    );
    worker = base.builds.runOne();
    await started;
    await base.db.query("update golden_build_jobs set lease_until=now()-interval '1 second' where id=$1", [job.jobId]);
    expect(await base.builds.runOne()).toBe(false);
    expect((await base.builds.status(base.people.admin, job.jobId)).state).toBe("recovery_required");
    await base.builds.reconcileOne();
    expect((await base.builds.status(base.people.admin, job.jobId)).state).toBe("failed");
    release();
    await worker;
    expect(allocations).toBe(1);
    expect((await base.db.query("select 1 from goldens where name='expired'")).rows).toEqual([]);
    expect((await base.db.query("select 1 from golden_backend_slots")).rows).toEqual([]);
  } finally {
    release();
    await worker;
    await base.close();
  }
});

test("queued rebuild rechecks current target visibility before credentials or builder side effects", async () => {
  const s = await fixture();
  try {
    const token = await s.token(s.people.owner);
    const target = (
      await s.db.query<{ id: string; provider_snapshot_id: string }>(
        "select id,provider_snapshot_id from goldens where name='mine'",
      )
    ).rows[0]!;
    await s.db.query(
      "insert into golden_backend_slots(provider,backend_id,max_goldens,org_id,owner_id,golden_id) values('boat','test-boat-account',1,$1,$2,$3)",
      [s.people.org, s.people.owner, target.id],
    );
    const response = await s.http(token, "golden/update", {
      name: "mine",
      org: s.people.org,
      idempotencyKey: crypto.randomUUID(),
      config: { repos: [{ url: "https://github.com/acme/web.git" }], init: [] },
    });
    expect(response.status).toBe(202);
    const job = (await response.json()) as GoldenBuildStatus;
    // Another authorized action shares the target, then the requester loses their admin role.
    await s.db.query("update members set role='admin' where org_id=$1 and user_id=$2", [s.people.org, s.people.owner]);
    await s.db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [s.people.owner]);
      await tx.query("select set_golden_visibility($1,'org')", [target.id]);
    });
    await s.db.query("update members set role='member' where org_id=$1 and user_id=$2", [s.people.org, s.people.owner]);
    await s.builds.runOne();
    expect(await s.builds.status(s.people.owner, job.jobId)).toMatchObject({
      state: "failed",
      phase: "authorization",
      errorCode: "build_failed",
    });
    expect(s.allocations()).toBe(0);
    expect(s.github.refreshed).toEqual([]);
    expect(s.boat.execs).toEqual([]);
    expect((await s.db.query("select provider_snapshot_id from goldens where id=$1", [target.id])).rows).toEqual([
      { provider_snapshot_id: target.provider_snapshot_id },
    ]);
    expect((await s.db.query("select golden_id,build_id from golden_backend_slots")).rows).toEqual([
      { golden_id: target.id, build_id: null },
    ]);
  } finally {
    await s.close();
  }
});

test("billing refusal fails without recovery, exposes a closed reason and frees capacity", async () => {
  const s = await fixture();
  try {
    s.boat.provider.createGolden = async () => {
      throw new ProviderError({
        provider: "boat",
        code: "payment_required",
        message: "unsafe upstream payload",
        retryable: false,
      });
    };
    const token = await s.token(s.people.admin);
    const admitted = await s.http(token, "golden/create", {
      name: "billing-refused",
      org: s.people.org,
      repos: ["acme/web"],
      idempotencyKey: crypto.randomUUID(),
    });
    const job = (await admitted.json()) as GoldenBuildStatus;
    expect(admitted.status).toBe(202);
    await s.builds.runOne();
    const status = await s.http(token, "golden/build/status", { jobId: job.jobId });
    expect(await status.json()).toMatchObject({
      state: "failed",
      failureReason: "provider_payment_required",
      result: null,
    });
    const mcp = await call(await s.client(token), "golden_build_status", { jobId: job.jobId });
    expect(mcp.data).toMatchObject({ state: "failed", failureReason: "provider_payment_required" });
    expect((await s.db.query("select 1 from golden_backend_slots")).rows).toEqual([]);
    expect((await s.db.query("select 1 from goldens where name='billing-refused'")).rows).toEqual([]);
  } finally {
    await s.close();
  }
});

test("owner-confirmed legacy payment refusal frees the stranded slot and permits a new build", async () => {
  const s = await fixture();
  try {
    const token = await s.token(s.people.admin);
    const body = {
      name: "legacy-billing",
      org: s.people.org,
      repos: ["acme/web"],
      idempotencyKey: crypto.randomUUID(),
    };
    const job = (await (await s.http(token, "golden/create", body)).json()) as GoldenBuildStatus;
    // Historical worker lost the closed refusal reason, but the operator has its original log.
    await s.db.query(
      "update golden_build_jobs set state='recovery_required',phase='builder',fence=$2,error_code='build_failed' where id=$1",
      [job.jobId, crypto.randomUUID()],
    );
    const blocked = await s.http(token, "golden/create", { ...body, idempotencyKey: crypto.randomUUID() });
    expect(blocked.status).toBe(409);
    const request = { jobId: job.jobId, confirmation: "provider_payment_required" };
    const response = await s.http(token, "golden/build/reconcile", request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "failed",
      failureReason: "provider_payment_required",
      result: null,
    });
    expect((await s.db.query("select 1 from golden_backend_slots")).rows).toEqual([]);
    expect(s.allocations()).toBe(0);
    const replay = await s.http(token, "golden/build/reconcile", request);
    expect(replay.status).toBe(200);
    expect((await s.http(token, "golden/create", { ...body, idempotencyKey: crypto.randomUUID() })).status).toBe(202);
  } finally {
    await s.close();
  }
});

test("legacy refusal reconciliation requires confirmation, mutation authority and an unallocated Boat create", async () => {
  const s = await fixture();
  try {
    const token = await s.token(s.people.admin);
    const job = (await (
      await s.http(token, "golden/create", {
        name: "guarded-legacy",
        org: s.people.org,
        repos: ["acme/web"],
        idempotencyKey: crypto.randomUUID(),
      })
    ).json()) as GoldenBuildStatus;
    await s.db.query(
      "update golden_build_jobs set state='recovery_required',phase='builder',fence=$2,error_code='build_failed' where id=$1",
      [job.jobId, crypto.randomUUID()],
    );
    const request = { jobId: job.jobId, confirmation: "provider_payment_required" };
    expect((await s.http(token, "golden/build/reconcile", { jobId: job.jobId })).status).toBe(400);
    expect((await s.http(await s.token(s.people.member), "golden/build/reconcile", request)).status).toBe(403);
    expect(
      (await s.http(await s.token(s.people.admin, s.people.otherOrg), "golden/build/reconcile", request)).status,
    ).toBe(404);
    for (const patch of [
      "state='queued'",
      "builder_id='known-builder'",
      "phase='snapshot'",
      "snapshot='known-snapshot'",
      "failure_reason='skillpack_integrity_failed'",
    ]) {
      await s.db.query("update golden_build_jobs set " + patch + " where id=$1", [job.jobId]);
      expect((await s.http(token, "golden/build/reconcile", request)).status).toBe(409);
      await s.db.query(
        "update golden_build_jobs set state='recovery_required',builder_id=null,phase='builder',snapshot=null,failure_reason=null where id=$1",
        [job.jobId],
      );
    }
    expect((await s.db.query("select 1 from golden_backend_slots")).rows).toHaveLength(1);
    expect((await s.builds.status(s.people.admin, job.jobId)).state).toBe("recovery_required");
  } finally {
    await s.close();
  }
});

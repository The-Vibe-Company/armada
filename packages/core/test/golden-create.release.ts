import { captureGitHubAuditLogs } from "../../../scripts/test-support/github-audit.ts";

// This contract must never silently skip in release validation.
if (!process.env.ARMADA_TEST_POSTGRES_URL) throw new Error("ARMADA_TEST_POSTGRES_URL is required");

// Release-only PostgreSQL contracts; retained unit cases stay in the sibling test file.
import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { migrationsDir } from "../../../scripts/db/apply.ts";
import { sqlOver } from "../../mcp-server/src/sql.ts";
import helperManifest from "../helper/manifest.json";
import {
  createGoldenCreateService,
  createSqlGoldenStore,
  createSqlVaultStore,
  encryptSecret,
  type GoldenActor,
  type Provider,
  ProviderError,
  type SandboxInfo,
  type Sql,
} from "../src/server.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const APP = { clientId: "Iv1.test", clientSecret: "github-client-secret" };

async function fixture(db: Sql): Promise<{ actor: GoldenActor; userId: string }> {
  const org = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await db.query("insert into auth.users (id) values ($1)", [userId]);
  await db.query("insert into orgs (id, name) values ($1, 'Example')", [org]);
  await db.query("insert into members (org_id, user_id, role) values ($1, $2, 'admin')", [org, userId]);
  return { actor: { userId, orgId: org, role: "admin" }, userId };
}

async function connectGitHub(db: Sql, userId: string): Promise<void> {
  await db.query(
    "insert into github_connections (user_id, github_id, login, refresh_token_enc) values ($1, 583231, 'octocat', $2)",
    [userId, await encryptSecret("ghr_refresh_octocat", KEY)],
  );
}

/** GitHub's REST surface a golden create needs: the OAuth refresh, `/user`, installations, a repo, and (optionally) a scoped installation token. */
function fakeGitHubFetch(revoked: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({
        access_token: "ghu_caller_access_token",
        refresh_token: "ghr_refresh_octocat_1",
        expires_in: 28_800,
        refresh_token_expires_in: 15_811_200,
      });
    }
    if (url === "https://api.github.com/user") return Response.json({ id: 583231, login: "octocat", name: null });
    if (url.includes("/user/installations")) {
      return Response.json({
        installations: [
          {
            id: 9,
            app_id: 1,
            app_slug: "armada",
            account: { login: "acme", type: "Organization" },
            repository_selection: "all",
          },
        ],
      });
    }
    if (url === "https://api.github.com/repos/acme/web") {
      return Response.json({ id: 7, name: "web", default_branch: "main", owner: { login: "acme" }, private: false });
    }
    if (url.includes("/access_tokens")) {
      return Response.json({
        token: `ghs_${"scoped_installation_token"}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url === "https://api.github.com/installation/token" && init?.method === "DELETE") {
      revoked.push(`ghs_${"scoped_installation_token"}`);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;
}

function readyProvider(): Provider {
  let next = 0;
  const sandbox = (): SandboxInfo => ({
    id: `bx_${++next}`,
    name: "box",
    state: "ready",
    providerState: "ready",
    labels: {},
  });
  const ok = { detached: false as const, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
  return {
    id: "boat",
    maxGoldens: 1,
    backendIdentity: async () => ({ id: "boat-account" }),
    harnesses: ["claude", "codex"],
    capabilities: { claude: caps(), codex: caps() },
    createGolden: async () => sandbox(),
    snapshot: async ({ name }) => ({ name, status: "ready" }),
    getSnapshot: async () => {
      throw new ProviderError({ provider: "boat", code: "not_found", message: "absent snapshot", retryable: false });
    },
    deleteSnapshot: async () => {},
    fork: async () => sandbox(),
    get: async () => sandbox(),
    list: async () => ({ items: [], cursor: null }),
    prompt: async () => ({ promptId: "p", conversationId: "c", status: "queued" }),
    getPrompt: async () => ({ promptId: "p", status: "finished", done: true }),
    steer: async () => ({ conversationId: "c", promptId: "p" }),
    interrupt: async () => {},
    sshKey: async () => ({ sshEndpoint: "ssh.test:22", hostKey: "ssh-ed25519 AAAA" }),
    exec: async ({ command }) =>
      command.includes("/helper/0.1.0/armada-helper") ? { ...ok, stdout: helperOutput } : ok,
    events: async () => ({ events: [], hasMore: false }),
    stop: async () => {},
    delete: async () => ({ status: "pending" }),
  };
}

function caps() {
  return {
    steer: "none" as const,
    interrupt: false,
    resume: false,
    parallelConversations: false,
    reasoningEffort: false,
    fast: false,
    streamsPartials: false,
    toolEvents: false,
    approvals: false,
  };
}

// A single PGlite connection cannot observe an uncommitted transaction from another session.
// This test runs on actual PostgreSQL using promise barriers, with no wall-clock ordering guesses.
test("invisible in-flight COMMIT cannot authorize deleting a ready golden artifact", async () => {
  const configured = process.env.ARMADA_TEST_POSTGRES_URL!;
  const admin = new Bun.SQL(configured);
  const name = `golden_review_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(configured);
  url.pathname = `/${name}`;
  const client = new Bun.SQL(url.href);
  const sql = sqlOver({
    unsafe: (text, params) => client.unsafe(text, params),
    begin: (work) => client.begin((tx) => work({ unsafe: (text, params) => tx.unsafe(text, params) })),
  });
  let finish!: () => void;
  const commitGate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let callbackDone!: () => void;
  const callbackFinished = new Promise<void>((resolve) => {
    callbackDone = resolve;
  });
  let pendingCommit: Promise<unknown> | undefined;
  let attempt: Promise<void> | undefined;
  try {
    const prereq = (await Bun.file(join(migrationsDir, "../../scripts/db/supabase-prereq.sql")).text()).replace(
      /^create role [^;]+;/gm,
      (command) => `do $$ begin ${command} exception when duplicate_object then null; end $$;`,
    );
    await client.unsafe(prereq);
    for (const file of (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort())
      await client.unsafe(await Bun.file(join(migrationsDir, file)).text());
    const { actor, userId } = await fixture(sql);
    await connectGitHub(sql, userId);
    const artifacts = new Set<string>();
    const deleted: string[] = [];
    let deletedArtifact!: () => void;
    const deletionObserved = new Promise<void>((resolve) => {
      deletedArtifact = resolve;
    });
    const provider: Provider = {
      ...readyProvider(),
      snapshot: async ({ name, sandboxId }) => {
        artifacts.add(name);
        return { name, sourceSandboxId: sandboxId, status: "ready" };
      },
      deleteSnapshot: async (name) => {
        deleted.push(name);
        artifacts.delete(name);
        deletedArtifact();
      },
    };
    const ambiguous: Sql = {
      query: sql.query,
      async transaction(work) {
        pendingCommit = sql.transaction!(async (tx) => {
          const result = await work(tx);
          callbackDone();
          await commitGate;
          return result;
        });
        // The real transaction callback has written/finalized, but COMMIT is still gated.
        await callbackFinished;
        throw new Error("transport disconnected before COMMIT acknowledgement");
      },
    };
    const service = createGoldenCreateService({
      sql: ambiguous,
      github: { store: createSqlVaultStore(sql), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
      installationApp: null,
      fetch: fakeGitHubFetch(),
      ssh: async () => {},
    });
    let failure: unknown;
    attempt = service.create(provider, actor, { name: "late", visibility: "org", repos: ["acme/web"] }).then(
      () => {},
      (error: unknown) => {
        failure = error;
      },
    );
    // Baseline cleanup can then block releasing the uncommitted slot. Observe deletion itself
    // rather than waiting for that deadlock or using wall-clock sleeps to release COMMIT.
    await Promise.race([attempt, deletionObserved]);
    // Independent real connection sees no row: that absence is NOT evidence of rollback.
    expect((await sql.query("select id from goldens")).rows).toHaveLength(0);
    expect(deleted).toEqual([]);
    expect(artifacts.has("golden-bx-1")).toBe(true);
    expect(failure).toMatchObject({ code: "conflict" });
    expect(String(failure)).toContain("reconcile the in-flight transaction");
    finish();
    await pendingCommit;
    const committed = await sql.query<{ provider_snapshot_id: string }>("select provider_snapshot_id from goldens");
    expect(committed.rows[0]?.provider_snapshot_id).toBe("golden-bx-1");
    expect(artifacts.has(committed.rows[0]!.provider_snapshot_id)).toBe(true);
    const slots = await sql.query<{ golden_id: string; build_id: string | null }>(
      "select golden_id,build_id from golden_backend_slots",
    );
    expect(slots.rows[0]?.golden_id).toBeTruthy();
    expect(slots.rows[0]?.build_id).toBeNull();
    // The independent known-negative case is a callback error acknowledged after actual rollback.
    // Keep loser cleanup: prior artifact and finalized binding must survive, new attempt is reclaimed.
    const prior = (await createSqlGoldenStore(sql).findByName(actor.orgId, "late"))[0]!;
    const rollbackSql: Sql = {
      query: sql.query,
      transaction: (work) =>
        sql.transaction!(async (tx) =>
          work({
            query: async (text, params) => {
              if (text.includes("finalize_golden_backend_slot")) throw new Error("known rollback callback");
              return tx.query(text, params);
            },
          }),
        ),
    };
    const knownLoser = createGoldenCreateService({
      sql: rollbackSql,
      github: { store: createSqlVaultStore(sql), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
      installationApp: null,
      fetch: fakeGitHubFetch(),
      ssh: async () => {},
    });
    await expect(
      knownLoser.create(provider, actor, {
        name: "late",
        visibility: "org",
        repos: ["acme/web"],
        existingGolden: prior,
      }),
    ).rejects.toMatchObject({ code: "build_failed" });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).not.toBe(prior.providerSnapshotId);
    expect(artifacts.has(prior.providerSnapshotId!)).toBe(true);
    expect((await createSqlGoldenStore(sql).findByName(actor.orgId, "late"))[0]?.providerSnapshotId).toBe(
      prior.providerSnapshotId,
    );
    expect(
      (await sql.query<{ build_id: string | null }>("select build_id from golden_backend_slots")).rows[0]?.build_id,
    ).toBeNull();
  } finally {
    finish();
    await pendingCommit?.catch(() => {});
    await attempt;
    await client.close();
    await admin.unsafe(`drop database "${name}" with (force)`);
    await admin.close();
  }
});

test("PostgreSQL concurrent rebuild publications commit exactly one replacement/outbox and cleanup failure cannot undo success", async () => {
  const a = new Bun.SQL(process.env.ARMADA_TEST_POSTGRES_URL!, { max: 2 });
  const b = new Bun.SQL(process.env.ARMADA_TEST_POSTGRES_URL!, { max: 2 });
  const sqlA = sqlOver(a),
    sqlB = sqlOver(b);
  try {
    const { actor, userId } = await fixture(sqlA);
    await connectGitHub(sqlA, userId);
    const snapshots = new Map<string, { source: string }>(),
      machines = new Map<string, boolean>();
    const deleted: string[] = [];
    let ordinal = 0,
      refuse: string | undefined;
    const provider: Provider = {
      ...readyProvider(),
      backendIdentity: async () => ({ id: "publication-" + actor.orgId }),
      managementIdentity: async () => ({ scope: "org", ownerId: actor.orgId }),
      createGolden: async () => {
        const id = "builder-" + actor.orgId + "-" + ++ordinal;
        machines.set(id, false);
        return { id, name: id, state: "ready", providerState: "ready", labels: {} };
      },
      snapshot: async ({ name, sandboxId }) => {
        snapshots.set(name, { source: sandboxId });
        return { name, status: "ready", sourceSandboxId: sandboxId, artifactId: "artifact-" + name };
      },
      getSnapshot: async (name) => {
        const row = snapshots.get(name);
        if (!row) throw new ProviderError({ provider: "boat", code: "not_found", message: "absent", retryable: false });
        return { name, status: "ready", sourceSandboxId: row.source, artifactId: "artifact-" + name };
      },
      get: async (id) => ({
        id,
        name: id,
        state: machines.get(id) ? "stopped" : "ready",
        providerState: "ready",
        labels: {},
      }),
      stop: async ({ sandboxId }) => {
        machines.set(sandboxId, true);
      },
      deleteSnapshot: async (name) => {
        deleted.push(name);
        if (name === refuse)
          throw new ProviderError({ provider: "boat", code: "forbidden", message: "refused", retryable: false });
        snapshots.delete(name);
      },
    };
    const service = (sql: Sql) =>
      createGoldenCreateService({
        sql,
        github: { store: createSqlVaultStore(sql), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
        installationApp: null,
        fetch: fakeGitHubFetch(),
        ssh: async () => {},
      });
    const input = { name: "web", visibility: "org" as const, repos: ["acme/web"] };
    const first = await service(sqlA).create(provider, actor, input);
    const before = (await createSqlGoldenStore(sqlA).findByName(actor.orgId, "web"))[0]!;
    const results = await Promise.allSettled([
      service(sqlA).create(provider, actor, { ...input, existingGolden: before }),
      service(sqlB).create(provider, actor, { ...input, existingGolden: before }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const current = (await createSqlGoldenStore(sqlA).findByName(actor.orgId, "web"))[0]!;
    expect(current.providerSnapshotId).not.toBe(first.snapshot);
    expect(
      (
        await sqlA.query("select old_snapshot,new_snapshot from golden_snapshot_retirements where golden_id=$1", [
          current.id,
        ])
      ).rows,
    ).toEqual([{ old_snapshot: first.snapshot, new_snapshot: current.providerSnapshotId }]);
    expect(
      (await sqlA.query("select build_id from golden_backend_slots where golden_id=$1", [current.id])).rows,
    ).toEqual([{ build_id: null }]);
    expect(deleted).not.toContain(first.snapshot);
    refuse = first.snapshot;
    const { GoldenSnapshotRetirements } = await import("../src/golden-snapshot-retirement.ts");
    const worker = new GoldenSnapshotRetirements({ sql: sqlA, encryptionKey: KEY, provider: async () => provider });
    await worker.runOne();
    expect((await createSqlGoldenStore(sqlA).findByName(actor.orgId, "web"))[0]?.providerSnapshotId).toBe(
      current.providerSnapshotId,
    );
    expect(snapshots.has(first.snapshot)).toBe(true);
    expect(snapshots.has(current.providerSnapshotId!)).toBe(true);
    refuse = undefined;
    await sqlA.query(
      "update golden_snapshot_retirements set next_attempt_at=now()-interval '1 second' where golden_id=$1",
      [current.id],
    );
    await worker.runOne();
    expect(snapshots.has(first.snapshot)).toBe(false);
    expect(snapshots.has(current.providerSnapshotId!)).toBe(true);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

const helperOutput = `x86_64\n${helperManifest.x86_64.digest}  /home/user/.local/share/armada/helper/0.1.0/armada-helper\n{"version":"0.1.0","protocol":1,"capabilities":["diagnose"]}\n`;

captureGitHubAuditLogs();

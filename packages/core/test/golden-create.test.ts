import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import {
  connectGolden,
  createGoldenCreateService,
  createSqlGoldenStore,
  createSqlVaultStore,
  encryptSecret,
  type GitHubInstallationApp,
  type GoldenActor,
  GoldenError,
  type Provider,
  ProviderError,
  type SandboxInfo,
} from "../src/server.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const APP = { clientId: "Iv1.test", clientSecret: "github-client-secret" };

describe("createGoldenCreateService, wired to a real database", () => {
  test("refuses a caller with no GitHub connection before touching the provider or the database", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const { actor } = await fixture(db);
      const service = createGoldenCreateService({
        sql: db,
        github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP },
        installationApp: null,
      });
      const untouched: Provider = readyProvider();
      await expect(
        service.create(untouched, actor, { name: "web", visibility: "org", repos: ["acme/web"] }),
      ).rejects.toThrow(GoldenError);
      const rows = await db.query("select 1 from goldens");
      expect(rows.rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  test("without GITHUB_APP_PRIVATE_KEY, checkout falls back to the caller's own token and persists a valid config", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const { actor, userId } = await fixture(db);
      await connectGitHub(db, userId);
      const sshCalls: { token: string; script: string }[] = [];
      const service = createGoldenCreateService({
        sql: db,
        github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
        installationApp: null,
        fetch: fakeGitHubFetch(),
        ssh: async (_provider, input) => {
          sshCalls.push(input);
        },
      });
      const result = await service.create(readyProvider(), actor, {
        name: "web",
        visibility: "org",
        repos: ["acme/web"],
        setup: "echo setup",
      });
      expect(result.snapshot).toBe("golden-bx_1");
      expect(sshCalls).toHaveLength(1);
      expect(sshCalls[0]?.token).toBe("ghu_caller_access_token");

      const row = await db.query<{
        visibility: string;
        boat_snapshot_id: string;
        boat_sandbox_id: string;
        config: { repos: { url: string; branch: string; dir: string }[]; init: string[] };
      }>("select visibility, boat_snapshot_id, boat_sandbox_id, config from goldens where name = 'web'");
      expect(row.rows[0]).toMatchObject({
        visibility: "org",
        boat_snapshot_id: "golden-bx_1",
        boat_sandbox_id: null,
        config: {
          repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }],
          init: ["echo setup"],
        },
      });
      const slots = await db.query("select golden_id, build_id from golden_backend_slots");
      expect(slots.rows).toHaveLength(1);
      expect((slots.rows[0] as { golden_id: string; build_id: string | null }).build_id).toBeNull();
    } finally {
      await db.close();
    }
  });

  test("Boat capacity requires a backend identity and a second factory build is refused globally", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const { actor, userId } = await fixture(db);
      await connectGitHub(db, userId);
      const options = {
        sql: db,
        github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
        installationApp: null,
        fetch: fakeGitHubFetch(),
        ssh: async () => {},
      };
      const service = createGoldenCreateService(options);
      const noIdentity = readyProvider();
      delete noIdentity.backendIdentity;
      await expect(
        service.create(noIdentity, actor, { name: "missing-id", visibility: "org", repos: ["acme/web"] }),
      ).rejects.toThrow("backend identity");
      await service.create(readyProvider(), actor, { name: "one", visibility: "org", repos: ["acme/web"] });
      const anotherFactory = createGoldenCreateService(options);
      await expect(
        anotherFactory.create(readyProvider(), actor, { name: "two", visibility: "org", repos: ["acme/web"] }),
      ).rejects.toThrow("capacity");
      expect((await db.query("select 1 from goldens")).rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  test("factory rolls back golden and retains no slot when atomic finalize fails", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const { actor, userId } = await fixture(db);
      await connectGitHub(db, userId);
      const original = db.query.bind(db);
      const originalTransaction = db.transaction?.bind(db);
      // Failure injection through the transaction client used by the real factory SQL path.
      db.transaction = (async (work) =>
        originalTransaction!(async (tx) => {
          const originalTx = tx.query.bind(tx);
          tx.query = (async (text: string, params?: unknown[]) => {
            if (text.includes("finalize_golden_backend_slot")) throw new Error("finalize exploded");
            return originalTx(text, params);
          }) as typeof tx.query;
          return work(tx);
        })) as typeof db.transaction;
      const deleted: string[] = [];
      const provider = {
        ...readyProvider(),
        deleteSnapshot: async (name: string) => {
          deleted.push(name);
        },
      };
      const service = createGoldenCreateService({
        sql: db,
        github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
        installationApp: null,
        fetch: fakeGitHubFetch(),
        ssh: async () => {},
      });
      await expect(
        service.create(provider, actor, { name: "bad-finalize", visibility: "org", repos: ["acme/web"] }),
      ).rejects.toThrow("finalize exploded");
      expect((await original("select 1 from goldens")).rows).toHaveLength(0);
      expect((await original("select 1 from golden_backend_slots")).rows).toHaveLength(0);
      expect(deleted).toEqual(["golden-bx_1"]);
    } finally {
      await db.close();
    }
  });

  test("with GITHUB_APP_PRIVATE_KEY configured, checkout uses a scoped installation token and revokes it", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const { actor, userId } = await fixture(db);
      await connectGitHub(db, userId);
      const installationApp: GitHubInstallationApp = {
        appId: "1",
        privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      };
      const revoked: string[] = [];
      const fetchImpl = fakeGitHubFetch(revoked);
      const sshCalls: { token: string }[] = [];
      const service = createGoldenCreateService({
        sql: db,
        github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP, fetch: fetchImpl },
        installationApp,
        fetch: fetchImpl,
        ssh: async (_provider, input) => {
          sshCalls.push(input);
        },
      });
      await service.create(readyProvider(), actor, { name: "web", visibility: "private", repos: ["acme/web"] });
      expect(sshCalls[0]?.token).toBe("ghs_scoped_installation_token");
      expect(revoked).toEqual(["ghs_scoped_installation_token"]);
    } finally {
      await db.close();
    }
  });

  test("a fail-closed scan stops the build before any snapshot or database row", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const { actor, userId } = await fixture(db);
      await connectGitHub(db, userId);
      const stops: string[] = [];
      const provider: Provider = {
        ...readyProvider(),
        exec: async () => ({
          detached: false,
          exitCode: 97,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
        }),
        stop: async ({ sandboxId }) => {
          stops.push(sandboxId);
        },
      };
      const service = createGoldenCreateService({
        sql: db,
        github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
        installationApp: null,
        fetch: fakeGitHubFetch(),
        ssh: async () => {},
      });
      await expect(
        service.create(provider, actor, { name: "web", visibility: "org", repos: ["acme/web"] }),
      ).rejects.toThrow(GoldenError);
      expect(stops).toEqual(["bx_1"]);
      const rows = await db.query("select 1 from goldens");
      expect(rows.rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});

test("rebuild retains last-good artifacts/config through scan, snapshot and SQL failures, then restores the committed revision", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    const { actor, userId } = await fixture(db);
    await connectGitHub(db, userId);
    let failure = "";
    let generation = 0;
    const artifacts = new Map<string, { source: string; content: number; status: "ready" | "failed" }>();
    const machines = new Map<string, { content: number; stopped: boolean }>();
    const deleted: string[] = [];
    let next = 0;
    const start = (content: number): SandboxInfo => {
      const id = `machine-${++next}`;
      machines.set(id, { content, stopped: false });
      return { id, name: "builder", state: "ready", providerState: "ready", labels: {} };
    };
    const provider: Provider = {
      ...readyProvider(),
      createGolden: async () => start(++generation),
      snapshot: async ({ name, sandboxId }) => {
        artifacts.set(name, {
          source: sandboxId,
          content: machines.get(sandboxId)!.content,
          status: failure === "snapshot" ? "failed" : "ready",
        });
        // Request can fail after the remote artifact was created.
        if (failure === "request") throw new Error("snapshot request lost");
        return { name, status: artifacts.get(name)!.status, sourceSandboxId: sandboxId };
      },
      getSnapshot: async (name) => {
        const artifact = artifacts.get(name);
        if (!artifact) throw new Error("absent artifact");
        return { name, status: artifact.status, sourceSandboxId: artifact.source };
      },
      deleteSnapshot: async (name) => {
        deleted.push(name);
        artifacts.delete(name);
      },
      stop: async ({ sandboxId }) => {
        machines.get(sandboxId)!.stopped = true;
      },
      get: async (id) => {
        const machine = machines.get(id);
        if (!machine)
          throw new ProviderError({ provider: "boat", code: "not_found", message: "absent", retryable: false });
        return { id, name: "master", state: machine.stopped ? "stopped" : "ready", providerState: "", labels: {} };
      },
      fork: async ({ from, noEnv }) => {
        expect(noEnv).toBe(true);
        const artifact = artifacts.get(from);
        if (!artifact || artifact.status !== "ready") throw new Error("unusable snapshot");
        return start(artifact.content);
      },
      exec: async () => ({
        detached: false,
        exitCode: failure === "scan" ? 97 : 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
      }),
    };
    const transaction = db.transaction.bind(db);
    db.transaction = (async (work) => {
      let finalized = false;
      const result = await transaction(async (tx) => {
        const query = tx.query.bind(tx);
        tx.query = (async (sql: string, params?: unknown[]) => {
          if (sql.includes("finalize_golden_backend_slot")) finalized = true;
          if (failure === "persist" && sql.includes("finalize_golden_backend_slot"))
            throw new Error("injected finalize failure");
          return query(sql, params);
        }) as typeof tx.query;
        return work(tx);
      });
      if (failure === "ack" && finalized) throw new Error("commit acknowledgement lost");
      return result;
    }) as typeof db.transaction;
    const service = createGoldenCreateService({
      sql: db,
      github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
      installationApp: null,
      fetch: fakeGitHubFetch(),
      ssh: async () => {},
    });
    const store = createSqlGoldenStore(db);
    const input = { name: "web", visibility: "org" as const, repos: ["acme/web"], setup: "echo old" };
    const first = await service.create(provider, actor, input);
    const before = (await store.findByName(actor.orgId, "web"))[0]!;
    expect(before.providerSandboxId).toBeNull();
    expect(machines.get(artifacts.get(first.snapshot)!.source)?.stopped).toBe(true);
    const unchanged = (await db.query("select * from goldens")).rows;
    const binding = (await db.query("select golden_id,backend_id,org_id,owner_id from golden_backend_slots")).rows;
    for (const stage of ["scan", "snapshot", "request", "persist"]) {
      failure = stage;
      await expect(
        service.create(provider, actor, { ...input, setup: "echo new", existingGolden: before }),
      ).rejects.toThrow();
      expect((await db.query("select * from goldens")).rows).toEqual(unchanged);
      expect((await db.query("select golden_id,backend_id,org_id,owner_id from golden_backend_slots")).rows).toEqual(
        binding,
      );
      expect([...artifacts.keys()]).toEqual([first.snapshot]);
      expect(deleted).not.toContain(first.snapshot);
      expect([...machines.values()].every((machine) => machine.stopped)).toBe(true);
    }
    failure = "";
    const updated = await service.create(provider, actor, { ...input, setup: "echo new", existingGolden: before });
    expect(updated.snapshot).not.toBe(first.snapshot);
    expect(artifacts.has(first.snapshot)).toBe(true);
    const after = (await store.findByName(actor.orgId, "web"))[0]!;
    expect(after.id).toBe(before.id);
    expect(after.providerSnapshotId).toBe(updated.snapshot);
    expect(after.config.init).toEqual(["echo new"]);
    expect(after.providerSandboxId).toBeNull();
    expect((await db.query("select golden_id,backend_id,org_id,owner_id from golden_backend_slots")).rows).toEqual(
      binding,
    );
    const connected = await connectGolden(provider, store, actor, "web");
    expect(machines.get(connected.sandbox.id)?.content).toBe(artifacts.get(updated.snapshot)?.content);
    expect(machines.get(connected.sandbox.id)?.stopped).toBe(false);
    // Stopped masters restore from the new revision, not the cleaned-up builder.
    await provider.stop({ sandboxId: connected.sandbox.id });
    const restored = await connectGolden(provider, store, actor, "web");
    expect(restored.sandbox.id).not.toBe(connected.sandbox.id);
    expect(machines.get(restored.sandbox.id)?.content).toBe(artifacts.get(updated.snapshot)?.content);
    // An ambiguous commit error must never delete an artifact the database actually committed.
    failure = "ack";
    const current = (await store.findByName(actor.orgId, "web"))[0]!;
    await expect(service.create(provider, actor, { ...input, existingGolden: current })).rejects.toThrow(
      "acknowledgement lost",
    );
    const committed = (await store.findByName(actor.orgId, "web"))[0]!;
    expect(committed.providerSnapshotId).not.toBe(updated.snapshot);
    expect(artifacts.has(committed.providerSnapshotId!)).toBe(true);
    expect(artifacts.has(updated.snapshot)).toBe(true);
  } finally {
    await db.close();
  }
});

async function fixture(db: Awaited<ReturnType<typeof openDatabase>>): Promise<{ actor: GoldenActor; userId: string }> {
  const org = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await db.query("insert into auth.users (id) values ($1)", [userId]);
  await db.query("insert into orgs (id, name) values ($1, 'Example')", [org]);
  await db.query("insert into members (org_id, user_id, role) values ($1, $2, 'admin')", [org, userId]);
  return { actor: { userId, orgId: org, role: "admin" }, userId };
}

async function connectGitHub(db: Awaited<ReturnType<typeof openDatabase>>, userId: string): Promise<void> {
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
        token: "ghs_scoped_installation_token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url === "https://api.github.com/installation/token" && init?.method === "DELETE") {
      revoked.push("ghs_scoped_installation_token");
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
    getSnapshot: async (name) => ({ name, status: "ready" }),
    deleteSnapshot: async () => {},
    fork: async () => sandbox(),
    get: async () => sandbox(),
    list: async () => ({ items: [], cursor: null }),
    prompt: async () => ({ promptId: "p", conversationId: "c", status: "queued" }),
    getPrompt: async () => ({ promptId: "p", status: "finished", done: true }),
    steer: async () => ({ conversationId: "c", promptId: "p" }),
    interrupt: async () => {},
    sshKey: async () => ({ sshEndpoint: "ssh.test:22", hostKey: "ssh-ed25519 AAAA" }),
    exec: async () => ok,
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

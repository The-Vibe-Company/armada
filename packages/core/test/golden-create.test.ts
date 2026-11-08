import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import {
  createGoldenCreateService,
  createSqlVaultStore,
  encryptSecret,
  type GitHubInstallationApp,
  type GoldenActor,
  GoldenError,
  type Provider,
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
      });
      expect(result.snapshot).toBe("golden-bx_1");
      expect(sshCalls).toHaveLength(1);
      expect(sshCalls[0]?.token).toBe("ghu_caller_access_token");

      const row = await db.query<{
        visibility: string;
        boat_snapshot_id: string;
        config: { repos: { url: string; branch: string; dir: string }[]; init: string[] };
      }>("select visibility, boat_snapshot_id, config from goldens where name = 'web'");
      expect(row.rows[0]).toMatchObject({
        visibility: "org",
        boat_snapshot_id: "golden-bx_1",
        config: { repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] },
      });
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
      return Response.json({ id: 7, name: "web", default_branch: "main", owner: { login: "acme" } });
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
    id: "fake",
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

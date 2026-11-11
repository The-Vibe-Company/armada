import { describe, expect, test } from "bun:test";
import { createMemoryAuthStore, memorySessionStore } from "@armada/auth";
import {
  createSqlGoldenStore,
  createSqlVaultStore,
  encryptSecret,
  type GoldenActor,
  GoldenBuildJobs,
  goldenForLaunch,
  type Provider,
} from "@armada/core/server";
import { type ControlOptions, createSqlData, handleControlRequest } from "@armada/mcp-server";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import type { AuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";

const WEB = "https://github.com/example/web.git";
const ENC_KEY = Buffer.alloc(32, 9).toString("base64");

describe("golden command", () => {
  test("a secret in the config is refused before any sandbox is created", async () => {
    const calls: string[] = [];
    const result = await capture(["golden", "create", "web", "--repo", WEB, "--init", "TOKEN=abc pnpm i"], {
      actor: admin(),
      store: failingStore(),
      provider: recordingProvider(calls),
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("must not contain secrets");
    expect(calls).toEqual([]);
  });

  test("create builds, scans and snapshots a multi-repo golden on the server, with no boat account environment", async () => {
    // golden create is server-orchestrated now (no separate connect/snapshot step for a golden
    // built this way, and no BOAT_API_KEY): the CLI sends the parsed --repo/--init config to
    // /api/v1/golden/create, which admits the durable disposable-builder job, then polls its status.
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const people = await fixture(db);
      await db.query(
        "insert into github_connections (user_id, github_id, login, refresh_token_enc) values ($1, 583231, 'octocat', $2)",
        [people.owner, await encryptSecret("ghr_refresh_octocat", ENC_KEY)],
      );
      await db.query("insert into credentials (scope, owner_id, kind, value_enc) values ('user', $1, 'boat', $2)", [
        people.owner,
        await encryptSecret("boat-owner-key", ENC_KEY),
      ]);
      const sshCalls: { token: string; script: string }[] = [];
      const githubFetch = fakeGitHubFetch();
      const authStore = createMemoryAuthStore();
      authStore.addMembership(people.owner, { orgId: people.org, name: "Example", role: "admin" });
      const controlOptions: ControlOptions = {
        authStore,
        supabase: { supabaseUrl: "https://supabase.test", anonKey: "anon", fetch: fakeSupabaseFetch(people.owner) },
        store: createSqlVaultStore(db),
        encryptionKey: ENC_KEY,
        data: createSqlData(db),
        providerFor: () => fakeCreateProvider(),
        goldenBuilds: new GoldenBuildJobs({
          sql: db,
          encryptionKey: ENC_KEY,
          provider: async () => fakeCreateProvider(),
          service: {
            github: {
              store: createSqlVaultStore(db),
              encryptionKey: ENC_KEY,
              app: { clientId: "Iv1.test", clientSecret: "secret" },
              fetch: githubFetch,
            },
            installationApp: null,
            fetch: githubFetch,
            ssh: async (_provider, input) => {
              sshCalls.push(input);
            },
          },
        }),
      };
      const routingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input.toString(), init);
        if (new URL(request.url).hostname === "armada.test") {
          return (await handleControlRequest(request, controlOptions)) ?? new Response("{}", { status: 404 });
        }
        throw new Error("unexpected host");
      }) as typeof fetch;
      const auth = loggedIn(people.owner, routingFetch, {
        SUPABASE_ANON_KEY: "anon",
        ARMADA_URL: "https://armada.test",
      });

      const created = await capture(
        [
          "golden",
          "create",
          "monorepo",
          "--private",
          "--repo",
          "https://github.com/acme/web.git@main",
          "--repo",
          "https://github.com/acme/api.git@dev",
          "--init",
          "pnpm i",
        ],
        {
          auth,
          sleep: async () => {
            await controlOptions.goldenBuilds!.runOne();
          },
        },
      );
      expect(created.code).toBe(0);
      expect(created.err).toContain("Build admission key:");
      expect(created.out).toContain("Created golden monorepo (private).");
      expect(created.out).toContain("golden-bx-1");
      expect(created.out).toContain("web, api");
      expect(sshCalls).toHaveLength(1);
      expect(sshCalls[0]?.token).toBe("ghu_caller_access_token");
      expect(sshCalls[0]?.script).toContain("pnpm i");

      const row = await db.query<{ config: { repos: { url: string; branch: string; dir: string }[] } }>(
        "select config from goldens where name = 'monorepo'",
      );
      expect(row.rows[0]?.config.repos).toEqual([
        { url: "https://github.com/acme/web.git", branch: "main", dir: "web" },
        { url: "https://github.com/acme/api.git", branch: "dev", dir: "api" },
      ]);

      // golden list itself now always goes through the Armada API (golden-api-list.test.ts,
      // packages/mcp-server/test/control.test.ts's "golden/list" case); visibility is checked
      // directly against the store here instead, the same way goldenForLaunch does it at launch.
      const store = createSqlGoldenStore(db);
      const owner = actor(people, "owner");
      expect(await asUser(db, people.owner, () => store.findByName(people.org, "monorepo"))).toHaveLength(1);
      expect(await asUser(db, people.member, () => store.findByName(people.org, "monorepo"))).toHaveLength(0);
      await expect(
        asUser(db, people.member, () => goldenForLaunch(store, actor(people, "member"), "monorepo")),
      ).rejects.toThrow(/No golden named 'monorepo'/);
      expect(await asUser(db, people.owner, () => goldenForLaunch(store, owner, "monorepo"))).toMatchObject({
        name: "monorepo",
        providerSnapshotId: "golden-bx_1",
      });
      await db.query(`insert into goldens
        (org_id, name, visibility, owner_id, provider, provider_snapshot_id, modal_workspace, modal_environment, modal_app_id, config)
        select org_id, name, visibility, owner_id, 'modal', 'im-cli', 'ws-cli', 'main', 'ap-cli', config
        from goldens where provider = 'boat' and name = 'monorepo'`);
      for (const command of ["connect", "snapshot"]) {
        const ambiguous = await capture(["golden", command, "monorepo"], { auth });
        expect(ambiguous.err).toContain("exists on boat and modal");
      }
      const modalOnly = await asUser(db, people.owner, () =>
        capture(["golden", "list", "--provider", "modal", "--json"], { auth }),
      );
      expect(JSON.parse(modalOnly.out).map((row: { provider: string }) => row.provider)).toEqual(["modal"]);
    } finally {
      await db.close();
    }
  });

  test("golden list acts as the logged-in user too, not only ARMADA_TOKEN (golden-api-list.test.ts covers that)", async () => {
    const org = "11111111-1111-4111-8111-111111111111";
    const user = "22222222-2222-4222-8222-222222222222";
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      await db.query("insert into auth.users (id) values ($1)", [user]);
      await db.query("insert into orgs (id, name) values ($1, 'Example')", [org]);
      await db.query("insert into members (org_id, user_id, role) values ($1, $2, 'member')", [org, user]);
      await db.query(
        "insert into goldens (org_id, name, visibility, owner_id, config) values ($1, 'web', 'org', $2, $3::jsonb)",
        [org, user, JSON.stringify({ repos: [{ url: WEB, branch: "main", dir: "web" }], init: [] })],
      );
      const authStore = createMemoryAuthStore();
      authStore.addMembership(user, { orgId: org, name: "Example", role: "member" });
      const controlOptions: ControlOptions = {
        authStore,
        supabase: { supabaseUrl: "https://supabase.test", anonKey: "anon-public", fetch: fakeSupabaseFetch(user) },
        store: createSqlVaultStore(db),
        encryptionKey: ENC_KEY,
        data: createSqlData(db),
      };
      const routingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input.toString(), init);
        if (new URL(request.url).hostname === "armada.test") {
          return (await handleControlRequest(request, controlOptions)) ?? new Response("{}", { status: 404 });
        }
        throw new Error(`unexpected host ${new URL(request.url).hostname}`);
      }) as typeof fetch;
      const auth = loggedIn(user, routingFetch, {
        SUPABASE_ANON_KEY: "anon-public",
        ARMADA_URL: "https://armada.test",
      });

      const result = await capture(["golden", "list", "--json"], { auth });
      expect(result.code).toBe(0);
      expect(result.out).toContain('"name": "web"');
      expect(result.out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    } finally {
      await db.close();
    }
  });

  test("golden commands without a login ask for one", async () => {
    const auth = loggedIn("22222222-2222-4222-8222-222222222222", fetch, { SUPABASE_ANON_KEY: "anon" });
    await auth.session.clear();
    const result = await capture(["golden", "list"], { auth });
    expect(result.code).toBe(1);
    expect(result.err).toContain("Set ARMADA_TOKEN or run armada login.");
  });
});

async function capture(argv: string[], deps: Parameters<typeof run>[2]) {
  let out = "";
  let err = "";
  const code = await run(argv, { out: (text) => (out += text), err: (text) => (err += text) }, deps);
  return { code, out, err };
}

function recordingProvider(calls: string[]) {
  return {
    id: "boat",
    harnesses: ["claude", "codex"] as const,
    capabilities: { claude: caps(), codex: caps() },
    createGolden: async () => {
      calls.push("create");
      throw new Error("create should not run");
    },
  } as never;
}

function failingStore() {
  return {
    list: async () => [],
    findByName: async () => [],
    insert: async () => {
      throw new Error("insert should not run");
    },
    setConfig: async () => {},
    setSandbox: async () => {},
    setSnapshot: async () => {},
  };
}

function admin(): GoldenActor {
  return actorOf("admin");
}

function actorOf(role: "admin" | "member"): GoldenActor {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    orgId: "11111111-1111-4111-8111-111111111111",
    role,
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

async function fixture(db: PGlite) {
  const people = {
    org: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    member: crypto.randomUUID(),
  };
  for (const user of [people.owner, people.member]) {
    await db.query("insert into auth.users (id) values ($1)", [user]);
  }
  await db.query("insert into orgs (id, name) values ($1, 'Example')", [people.org]);
  await db.query(`insert into members (org_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')`, [
    people.org,
    people.owner,
    people.member,
  ]);
  return people;
}

function actor(people: { org: string; owner: string; member: string }, who: "owner" | "member"): GoldenActor {
  return { userId: people[who], orgId: people.org, role: "member" };
}

async function asUser<T>(db: PGlite, userId: string, run: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await db.exec("set local role authenticated");
    const value = await run();
    await db.exec("commit");
    return value;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

function loggedIn(userId: string, fetchImpl: typeof fetch, env: Record<string, string>): AuthIo {
  const session = memorySessionStore({
    userId,
    accessToken: `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: userId })).replace(/=+$/, "")}.sig`,
    refreshToken: "refresh",
    expiresAt: "2099-01-01T00:00:00.000Z",
    supabaseUrl: "https://supabase.test",
  });
  return {
    out: () => undefined,
    err: () => undefined,
    env,
    fetch: fetchImpl,
    now: () => new Date("2026-11-08T00:00:00.000Z"),
    open: () => undefined,
    session,
  };
}

function fakeSupabaseFetch(userId: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const authorization =
      input instanceof Request
        ? (input.headers.get("authorization") ?? "")
        : (new Headers(init?.headers).get("authorization") ?? "");
    if (url.hostname === "supabase.test" && url.pathname === "/auth/v1/user" && authorization.startsWith("Bearer ")) {
      return Response.json({ id: userId });
    }
    return new Response("{}", { status: 401 });
  }) as typeof fetch;
}

/** GitHub's REST surface a golden create needs: `/user`, installations, a repo lookup. */
function fakeGitHubFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
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
    const repo = /^https:\/\/api\.github\.com\/repos\/acme\/([a-z0-9-]+)$/.exec(url);
    if (repo?.[1]) {
      return Response.json({
        id: repo[1] === "web" ? 7 : 8,
        name: repo[1],
        default_branch: repo[1] === "api" ? "dev" : "main",
        owner: { login: "acme" },
        private: false,
      });
    }
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;
}

function fakeCreateProvider(): Provider {
  const ok = { detached: false as const, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
  return {
    id: "boat",
    maxGoldens: 1,
    backendIdentity: async () => ({ id: "cli-boat-account" }),
    harnesses: ["claude", "codex"],
    capabilities: { claude: caps(), codex: caps() },
    createGolden: async () => ({ id: "bx_1", name: "box", state: "ready", providerState: "ready", labels: {} }),
    snapshot: async ({ name }) => ({ name, status: "ready" }),
    getSnapshot: async (name) => ({ name, status: "ready" }),
    deleteSnapshot: async () => {},
    fork: async () => ({ id: "bx_1", name: "box", state: "ready", providerState: "ready", labels: {} }),
    get: async () => ({ id: "bx_1", name: "box", state: "ready", providerState: "ready", labels: {} }),
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

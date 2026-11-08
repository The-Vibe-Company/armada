import { describe, expect, test } from "bun:test";
import { memorySessionStore } from "@armada/auth";
import { boatSnapshotName, createSqlGoldenStore, GOLDEN_ROOT, type GoldenActor, goldenForLaunch } from "@armada/core";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import type { AuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";

const WEB = "https://github.com/example/web.git";
const API = "https://github.com/example/api.git";
const KEY = "boat_test_key_not_real";

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

  test("create and snapshot a multi-repo golden without the boat account environment", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const people = await fixture(db);
      const store = createSqlGoldenStore(db);
      const owner = actor(people, "owner");
      const requests: { method: string; path: string; body: unknown }[] = [];
      const fetchImpl = fakeBoat(requests);

      const created = await asUser(db, people.owner, () =>
        capture(
          [
            "golden",
            "create",
            "monorepo",
            "--private",
            "--repo",
            `${WEB}@main`,
            "--repo",
            `${API}@dev`,
            "--init",
            "pnpm i",
          ],
          {
            actor: owner,
            store,
            env: { BOAT_API_KEY: KEY },
            fetch: fetchImpl,
            sleep: async () => {},
            sandboxPolls: 3,
            snapshotPolls: 5,
          },
        ),
      );
      expect(created.code).toBe(0);
      expect(created.err).toBe("");
      expect(created.out).toContain("Created golden monorepo (private).");
      expect(created.out).toContain("none of the boat account's credentials");
      const snapshotName = boatSnapshotName({
        orgId: people.org,
        ownerId: people.owner,
        visibility: "private",
        name: "monorepo",
      });
      expect(created.out).toContain(snapshotName);
      expect(requests[0]).toMatchObject({ method: "POST", path: "/api/v1/sandboxes" });
      expect(requests[0]?.body).toMatchObject({ noEnv: true, ttlSeconds: 86400 });
      expect(requests[0]?.body).not.toHaveProperty("env");
      expect(requests[0]?.body).not.toHaveProperty("environment");
      expect(JSON.stringify(requests[0]?.body)).not.toContain(KEY);
      const commands = requests.filter((request) => request.path.endsWith("/commands")).map((request) => request.body);
      expect(JSON.stringify(commands[0])).toContain(WEB);
      expect(JSON.stringify(commands[1])).toContain(API);
      expect(commands[2]).toMatchObject({ command: "pnpm i", cwd: GOLDEN_ROOT });

      const snapshotted = await asUser(db, people.owner, () =>
        capture(["golden", "snapshot", "monorepo"], {
          actor: owner,
          store,
          env: { BOAT_API_KEY: KEY },
          fetch: fakeBoat(requests, { phase: "snapshot", name: snapshotName }),
          sleep: async () => {},
          snapshotPolls: 5,
        }),
      );
      expect(snapshotted.code).toBe(0);
      expect(snapshotted.out).toContain(`Saved snapshot: ${snapshotName}`);

      const listed = await asUser(db, people.owner, () => capture(["golden", "list"], { actor: owner, store }));
      expect(listed.out).toContain("monorepo  private  snapshot  2 repos");
      const hidden = await asUser(db, people.member, () =>
        capture(["golden", "list", "--json"], { actor: actor(people, "member"), store }),
      );
      expect(hidden.out).toBe("[]\n");
      await expect(
        asUser(db, people.member, () => goldenForLaunch(store, actor(people, "member"), "monorepo")),
      ).rejects.toThrow(/No golden named 'monorepo'/);
      expect(await asUser(db, people.owner, () => goldenForLaunch(store, owner, "monorepo"))).toMatchObject({
        name: "monorepo",
        boatSnapshotId: snapshotName,
      });
    } finally {
      await db.close();
    }
  });

  test("golden commands act as the logged-in user and --org picks the org", async () => {
    const orgA = "11111111-1111-4111-8111-111111111111";
    const orgB = "44444444-4444-4444-8444-444444444444";
    const user = "22222222-2222-4222-8222-222222222222";
    const seen: { url: string; authorization: string | null; apikey: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      seen.push({ url: url.toString(), authorization: headers.get("authorization"), apikey: headers.get("apikey") });
      if (url.hostname !== "supabase.test") throw new Error(`unexpected host ${url.hostname}`);
      if (url.pathname.endsWith("/members")) {
        return Response.json([
          { org_id: orgA, role: "member", orgs: { name: "Alpha" } },
          { org_id: orgB, role: "admin", orgs: { name: "Beta" } },
        ]);
      }
      if (url.pathname.endsWith("/goldens")) {
        return Response.json([
          {
            id: "33333333-3333-4333-8333-333333333333",
            org_id: url.searchParams.get("org_id")?.replace("eq.", ""),
            name: "web",
            visibility: "org",
            owner_id: user,
            boat_snapshot_id: null,
            boat_sandbox_id: "bx_1",
            config: { repos: [{ url: WEB, branch: "main", dir: "web" }], init: [] },
            created_at: "2026-11-08T12:00:00.000Z",
          },
        ]);
      }
      throw new Error(`unexpected ${url.pathname}`);
    }) as typeof fetch;
    const auth = loggedIn(user, fetchImpl, {
      SUPABASE_ANON_KEY: "anon-public",
      ARMADA_ACCESS_TOKEN: "stale-env-identity",
      ARMADA_SUPABASE_URL: "https://elsewhere.test",
    });

    const ambiguous = await capture(["golden", "list"], { auth });
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.err).toContain("Name the org with --org. You belong to 2 orgs.");

    const result = await capture(["golden", "list", "--json", "--org", "beta"], { auth });
    expect(result.code).toBe(0);
    expect(result.out).toContain('"name": "web"');
    expect(result.out).not.toContain("access-from-login");
    expect(seen.every((call) => call.url.startsWith("https://supabase.test/"))).toBe(true);
    expect(seen.every((call) => call.authorization === "Bearer access-from-login")).toBe(true);
    expect(seen.every((call) => call.apikey === "anon-public")).toBe(true);
    expect(seen.some((call) => call.url.includes(`org_id=eq.${orgB}`))).toBe(true);
    expect(seen.some((call) => call.url.includes("/boat"))).toBe(false);

    const outsider = await capture(["golden", "list", "--org", "Gamma"], { auth });
    expect(outsider.code).toBe(1);
    expect(outsider.err).toContain("You are not a member of that org.");
  });

  test("golden commands without a login ask for one", async () => {
    const auth = loggedIn("22222222-2222-4222-8222-222222222222", fetch, { SUPABASE_ANON_KEY: "anon" });
    await auth.session.clear();
    const result = await capture(["golden", "list"], { auth });
    expect(result.code).toBe(1);
    expect(result.err).toContain("Run armada login.");
  });

  test("create without a boat key explains that the boat account is not a credential store", async () => {
    const result = await capture(["golden", "create", "web", "--private", "--repo", WEB], {
      actor: actorOf("member"),
      store: failingStore(),
      env: {},
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("Set BOAT_API_KEY");
    expect(result.err).toContain("does not use credentials stored on the boat.dev account");
  });
});

async function capture(argv: string[], deps: Parameters<typeof run>[2]) {
  let out = "";
  let err = "";
  const code = await run(argv, { out: (text) => (out += text), err: (text) => (err += text) }, deps);
  return { code, out, err };
}

function fakeBoat(
  requests: { method: string; path: string; body: unknown }[],
  mode: { phase: "create" | "snapshot"; name?: string } = { phase: "create" },
): typeof fetch {
  let snapshotReads = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const text = typeof init?.body === "string" ? init.body : undefined;
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      body: text === undefined ? undefined : JSON.parse(text),
    });
    if (url.pathname === "/api/v1/sandboxes" && (init?.method ?? "GET") === "POST") {
      return Response.json({ ok: true, type: "sandbox.created", sandbox: sandbox("ready") }, { status: 202 });
    }
    if (url.pathname.endsWith("/commands")) {
      return Response.json({
        ok: true,
        type: "command.finished",
        success: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      });
    }
    if (url.pathname === "/api/v1/saved-snapshots" && init?.method === "POST") {
      return Response.json(
        { ok: true, type: "snapshot.saved.saving", status: "saving", snapshot: { name: mode.name, status: "saving" } },
        { status: 202 },
      );
    }
    if (url.pathname.startsWith("/api/v1/saved-snapshots/")) {
      snapshotReads += 1;
      const status = snapshotReads === 1 ? "saving" : "ready";
      return Response.json({ ok: true, type: "snapshot.saved.info", snapshot: { name: mode.name, status } });
    }
    if (url.pathname.startsWith("/api/v1/sandboxes/")) {
      return Response.json({ ok: true, type: "sandbox.info", sandbox: sandbox("idle") });
    }
    throw new Error(`unexpected ${init?.method} ${url.pathname}`);
  }) as typeof fetch;
}

function sandbox(state: string) {
  return {
    id: "bx_23456789",
    name: "monorepo",
    state,
    desktopAvailable: false,
    snapshotAvailable: false,
    createdAt: "2026-11-08T12:00:00.000Z",
    archiveAfter: "2026-11-09T12:00:00.000Z",
    labels: { armada: "golden" },
  };
}

function recordingProvider(calls: string[]) {
  return {
    id: "fake",
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
    accessToken: "access-from-login",
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

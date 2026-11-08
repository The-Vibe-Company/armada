import { describe, expect, test } from "bun:test";
import { memorySessionStore } from "@armada/auth";
import {
  type CredentialKind,
  createSqlGoldenStore,
  createSqlSandboxStore,
  createSqlVaultStore,
  encryptSecret,
  GOLDEN_ROOT,
  type GoldenActor,
  type VaultStore,
} from "@armada/core";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import type { AuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";

const BOAT_KEY = "boat_test_key_not_real";
const PERSONAL_BOAT_KEY = "boat_personal_key_not_real";
const CLAUDE_TOKEN = "sk-ant-oat01-cli-test-token";
const ORG_CLAUDE_TOKEN = "sk-ant-oat01-org-token";
const ANTHROPIC_KEY = "sk-ant-api03-cli-test-key";
const OPENAI_KEY = "sk-cli-test-openai-key";
const AUTH_JSON = '{"tokens":{"access_token":"codex-access-do-not-leak"}}';
const KEY = Buffer.alloc(32, 4).toString("base64");
const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const USER_UUID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT = `a${"1".repeat(62)}`;
const CONFIG = JSON.stringify({
  repos: [
    { url: "https://github.com/example/web.git", branch: "main", dir: "web" },
    { url: "https://github.com/example/api.git", branch: "dev", dir: "api" },
  ],
  init: ["pnpm i"],
});

describe("launch command", () => {
  test("launches Claude with a prompt from a stored golden and forks with only Armada's credentials in the environment", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const people = await fixture(db);
      await seed(db, people, [
        { scope: "user", owner: people.owner, kind: "claude_oauth", value: CLAUDE_TOKEN },
        { scope: "org", owner: people.org, kind: "openai", value: OPENAI_KEY },
      ]);
      const requests: Request[] = [];
      const result = await asUser(db, people.owner, () =>
        capture(["launch", "monorepo", "--agent", "claude", "--ttl", "2h", "Fix the build"], {
          actor: actor(people, "owner"),
          store: createSqlGoldenStore(db),
          sandboxes: createSqlSandboxStore(db),
          vault: { store: vaultStore(db), encryptionKey: KEY },
          fetch: fakeBoat(requests),
          sleep: async () => {},
          sandboxPolls: 3,
        }),
      );
      expect(result.err).toBe("");
      expect(result.code).toBe(0);
      expect(result.out).toContain("Launched claude from golden monorepo (private).");
      expect(result.out).toContain("Status: running");
      expect(result.out).toContain("Conversation: conv_1");
      expect(result.out).not.toContain(CLAUDE_TOKEN);

      const fork = requests.find((request) => request.method === "POST" && request.path === "/api/v1/sandboxes");
      expect(fork?.body).toEqual({
        from: SNAPSHOT,
        ttlSeconds: 7200,
        noEnv: true,
        env: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN },
        labels: expect.objectContaining({
          armada: "sandbox",
          harness: "claude",
          golden: "monorepo",
          owner: people.owner,
        }),
      });
      expect(JSON.stringify(fork?.body)).not.toContain(OPENAI_KEY);
      expect(fork?.authorization).toBe(`Bearer ${BOAT_KEY}`);
      expect(JSON.stringify(fork?.body)).not.toContain(BOAT_KEY);
      const commands = requests.filter((request) => request.path.endsWith("/commands")).map((request) => request.body);
      expect(commands).toMatchObject([
        { cwd: `${GOLDEN_ROOT}/web` },
        { cwd: `${GOLDEN_ROOT}/api` },
        { command: "pnpm i", cwd: GOLDEN_ROOT },
      ]);
      const prompt = requests.find((request) => request.path.endsWith("/prompt"));
      expect(prompt?.body).toMatchObject({ provider: "claude-code", prompt: "Fix the build", new: true });
      expect(requests.every((request) => !JSON.stringify(request.body ?? null).includes(BOAT_KEY))).toBe(true);

      const row = await db.query<{ status: string; conversation_ids: string[]; owner_id: string }>(
        "select status::text as status, conversation_ids, owner_id from sandboxes",
      );
      expect(row.rows).toEqual([{ status: "running", conversation_ids: ["conv_1"], owner_id: people.owner }]);
    } finally {
      await db.close();
    }
  });

  test("launches Codex idle with --json, and another member cannot launch the private golden", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const people = await fixture(db);
      await seed(db, people, [{ scope: "user", owner: people.owner, kind: "openai", value: OPENAI_KEY }]);
      const requests: Request[] = [];
      const deps = (who: "owner" | "member") => ({
        actor: actor(people, who),
        store: createSqlGoldenStore(db),
        sandboxes: createSqlSandboxStore(db),
        vault: { store: vaultStore(db), encryptionKey: KEY },
        fetch: fakeBoat(requests),
        sleep: async () => {},
        sandboxPolls: 3,
      });

      const refused = await asUser(db, people.member, () =>
        capture(["launch", "monorepo", "--agent", "codex"], deps("member")),
      );
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("No golden named 'monorepo'");
      expect(requests).toEqual([]);

      const idle = await asUser(db, people.owner, () =>
        capture(["launch", "monorepo", "--agent", "codex", "--json"], deps("owner")),
      );
      expect(idle.code).toBe(0);
      const json = JSON.parse(idle.out);
      expect(json).toMatchObject({
        harness: "codex",
        status: "ready",
        conversationIds: [],
        promptId: null,
        ttlSeconds: 14_400,
      });
      const fork = requests.find((request) => request.path === "/api/v1/sandboxes" && request.method === "POST");
      expect(fork?.body).toMatchObject({ noEnv: true, env: { OPENAI_API_KEY: OPENAI_KEY }, ttlSeconds: 14_400 });
      expect(requests.some((request) => request.path.endsWith("/prompt"))).toBe(false);
    } finally {
      await db.close();
    }
  });

  test("a failing init exits 1 with the command output and records the sandbox as failed", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const people = await fixture(db);
      await seed(db, people, [{ scope: "user", owner: people.owner, kind: "claude_oauth", value: CLAUDE_TOKEN }]);
      const requests: Request[] = [];
      const result = await asUser(db, people.owner, async () => {
        const out = await capture(["launch", "monorepo", "--agent", "claude", "go"], {
          actor: actor(people, "owner"),
          store: createSqlGoldenStore(db),
          sandboxes: createSqlSandboxStore(db),
          vault: { store: vaultStore(db), encryptionKey: KEY },
          fetch: fakeBoat(requests, { failing: "pnpm i" }),
          sleep: async () => {},
          sandboxPolls: 3,
        });
        return out;
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain("init command 1 failed (exit 1).");
      expect(result.err).toContain("ERR_PNPM_NO_LOCKFILE");
      expect(result.err).not.toContain(CLAUDE_TOKEN);
      expect(requests.some((request) => request.path.endsWith("/stop"))).toBe(true);
      expect(requests.some((request) => request.path.endsWith("/prompt"))).toBe(false);
      const row = await db.query<{ status: string }>("select status::text as status from sandboxes");
      expect(row.rows).toEqual([{ status: "failed" }]);
    } finally {
      await db.close();
    }
  });

  test("bad flags and a missing credential fail before anything starts", async () => {
    const calls: string[] = [];
    const base = {
      actor: { userId: USER_UUID, orgId: ORG_UUID, role: "member" } as GoldenActor,
      store: { list: async () => [], findByName: async () => [] } as never,
      sandboxes: {} as never,
      fetch: (async () => {
        calls.push("fetch");
        throw new Error("no network");
      }) as unknown as typeof fetch,
    };
    expect((await capture(["launch", "web"], base)).err).toContain("Pass --agent claude or codex");
    expect((await capture(["launch", "web", "--agent", "opencode"], base)).code).toBe(2);
    expect((await capture(["launch", "web", "--agent", "claude", "--ttl", "soon"], base)).err).toContain(
      "is not a duration",
    );
    expect((await capture(["launch", "--agent", "claude"], base)).code).toBe(2);
    expect((await capture(["launch", "web", "--agent", "claude", "a", "b"], base)).code).toBe(2);
    expect(calls).toEqual([]);
  });

  test("over Supabase it reads the golden and records the sandbox as the signed-in user", async () => {
    const seen: { host: string; method: string; path: string; authorization: string | null; body: unknown }[] = [];
    const golden = {
      id: "33333333-3333-4333-8333-333333333333",
      org_id: ORG_UUID,
      name: "monorepo",
      visibility: "org",
      owner_id: USER_UUID,
      boat_snapshot_id: SNAPSHOT,
      boat_sandbox_id: "bx_builder",
      config: JSON.parse(CONFIG),
      created_at: "2026-11-08T12:00:00.000Z",
    };
    let inserted: Record<string, unknown> = {};
    const supabase = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const text = typeof init?.body === "string" ? init.body : undefined;
      const body = text === undefined ? undefined : JSON.parse(text);
      seen.push({
        host: url.hostname,
        method: init?.method ?? "GET",
        path: url.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
        body,
      });
      if (url.hostname === "boat.dev") return boatReply(url, init?.method ?? "GET", body, { requests: [] });
      if (url.pathname.endsWith("/members")) return Response.json([{ org_id: ORG_UUID, role: "member" }]);
      if (url.pathname.endsWith("/goldens")) return Response.json([golden]);
      if (url.pathname.endsWith("/sandboxes") && init?.method === "POST") {
        inserted = {
          ...body,
          conversation_ids: [],
          created_at: "2026-11-08T12:00:00.000Z",
          stopped_at: null,
          deleted_at: null,
        };
        return Response.json([inserted], { status: 201 });
      }
      if (url.pathname.endsWith("/sandboxes") && init?.method === "PATCH") return Response.json([{ id: inserted.id }]);
      throw new Error(`unexpected ${init?.method} ${url.pathname}`);
    }) as typeof fetch;

    const orgKey = await encryptSecret(CLAUDE_TOKEN, KEY);
    const boatKey = await encryptSecret(BOAT_KEY, KEY);
    const stored: VaultStore = {
      async credentials(scope: string) {
        return scope === "org" ? [{ kind: "claude_oauth" as const, valueEnc: orgKey }] : [];
      },
      async orgBoatKey() {
        return boatKey;
      },
    } as unknown as VaultStore;
    const result = await capture(["launch", "monorepo", "--agent", "claude", "go"], {
      auth: login(USER_UUID, supabase),
      vault: { store: stored, encryptionKey: KEY },
      fetch: supabase,
      sleep: async () => {},
      sandboxPolls: 3,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const rest = seen.filter((call) => call.path.startsWith("/rest/v1/"));
    expect(rest.every((call) => call.authorization === "Bearer access-from-login")).toBe(true);
    const insert = rest.find((call) => call.method === "POST");
    expect(insert?.body).toMatchObject({
      boat_id: "bx_1",
      golden_id: golden.id,
      org_id: ORG_UUID,
      owner_id: USER_UUID,
      harness: "claude",
      status: "starting",
    });
    expect(rest.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({
      status: "running",
      conversation_ids: ["conv_1"],
    });
    const boat = seen.filter((call) => call.host === "boat.dev");
    expect(boat.length).toBeGreaterThan(0);
    expect(boat.every((call) => call.authorization === `Bearer ${BOAT_KEY}`)).toBe(true);
    expect(result.out).not.toContain(CLAUDE_TOKEN);
  });

  test("the user's credential wins over the org's, and a private golden uses the owner's boat key", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const people = await fixture(db);
      await seed(db, people, [
        { scope: "user", owner: people.owner, kind: "anthropic", value: ANTHROPIC_KEY },
        { scope: "org", owner: people.org, kind: "claude_oauth", value: ORG_CLAUDE_TOKEN },
        { scope: "user", owner: people.owner, kind: "boat", value: PERSONAL_BOAT_KEY },
      ]);
      const requests: Request[] = [];
      const result = await asUser(db, people.owner, () =>
        capture(["launch", "monorepo", "--agent", "claude", "go"], {
          actor: actor(people, "owner"),
          store: createSqlGoldenStore(db),
          sandboxes: createSqlSandboxStore(db),
          vault: { store: vaultStore(db), encryptionKey: KEY },
          fetch: fakeBoat(requests),
          sleep: async () => {},
          sandboxPolls: 3,
        }),
      );
      expect(result.code).toBe(0);
      const fork = requests.find((request) => request.method === "POST" && request.path === "/api/v1/sandboxes");
      expect(fork?.body).toMatchObject({ noEnv: true, env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } });
      expect(JSON.stringify(fork?.body)).not.toContain(ORG_CLAUDE_TOKEN);
      expect(fork?.authorization).toBe(`Bearer ${PERSONAL_BOAT_KEY}`);
      expect(result.out).not.toContain(ANTHROPIC_KEY);
      expect(result.out).not.toContain(PERSONAL_BOAT_KEY);
    } finally {
      await db.close();
    }
  });

  test("a Codex auth.json is written into the sandbox from the environment, never the command line", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const people = await fixture(db);
      await seed(db, people, [{ scope: "user", owner: people.owner, kind: "codex_auth", value: AUTH_JSON }]);
      const requests: Request[] = [];
      const result = await asUser(db, people.owner, () =>
        capture(["launch", "monorepo", "--agent", "codex"], {
          actor: actor(people, "owner"),
          store: createSqlGoldenStore(db),
          sandboxes: createSqlSandboxStore(db),
          vault: { store: vaultStore(db), encryptionKey: KEY },
          fetch: fakeBoat(requests),
          sleep: async () => {},
          sandboxPolls: 3,
        }),
      );
      expect(result.code).toBe(0);
      const fork = requests.find((request) => request.method === "POST" && request.path === "/api/v1/sandboxes");
      expect(fork?.body).toMatchObject({ env: { ARMADA_CODEX_AUTH_JSON: AUTH_JSON } });
      const wrote = requests.find((request) => JSON.stringify(request.body ?? "").includes("auth.json"));
      if (!wrote) throw new Error("the launch never wrote auth.json");
      const command = (wrote.body as { command: string }).command;
      expect(command).toContain('"$ARMADA_CODEX_AUTH_JSON" > /home/user/.codex/auth.json');
      expect(command).not.toContain("codex-access-do-not-leak");
      expect(result.out).not.toContain("codex-access-do-not-leak");
    } finally {
      await db.close();
    }
  });

  test("a launch with no credential fails before any sandbox starts", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const people = await fixture(db);
      await seed(db, people, []);
      const requests: Request[] = [];
      const result = await asUser(db, people.owner, () =>
        capture(["launch", "monorepo", "--agent", "claude", "go"], {
          actor: actor(people, "owner"),
          store: createSqlGoldenStore(db),
          sandboxes: createSqlSandboxStore(db),
          vault: { store: vaultStore(db), encryptionKey: KEY },
          fetch: fakeBoat(requests),
          sleep: async () => {},
          sandboxPolls: 3,
        }),
      );
      expect(result.code).toBe(1);
      expect(result.err).toContain("armada creds set claude-oauth");
      expect(requests).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

interface Request {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

async function capture(argv: string[], deps: Parameters<typeof run>[2]) {
  let out = "";
  let err = "";
  const code = await run(argv, { out: (text) => (out += text), err: (text) => (err += text) }, deps);
  return { code, out, err };
}

function fakeBoat(requests: Request[], options: { failing?: string } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof globalThis.Request ? input.url : String(input));
    const text = typeof init?.body === "string" ? init.body : undefined;
    const body = text === undefined ? undefined : JSON.parse(text);
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      body,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return boatReply(url, init?.method ?? "GET", body, options);
  }) as typeof fetch;
}

function boatReply(
  url: URL,
  method: string,
  body: unknown,
  options: { failing?: string; requests?: unknown[] },
): Response {
  const path = url.pathname;
  if (path === "/api/v1/sandboxes" && method === "POST") {
    return Response.json({ ok: true, type: "sandbox.created", sandbox: sandbox("provisioning") }, { status: 202 });
  }
  if (path.endsWith("/commands")) {
    const failing = options.failing !== undefined && (body as { command?: string }).command === options.failing;
    return Response.json({
      ok: true,
      type: "command.finished",
      success: !failing,
      exitCode: failing ? 1 : 0,
      stdout: "",
      stderr: failing ? `ERR_PNPM_NO_LOCKFILE no lockfile (token ${CLAUDE_TOKEN})` : "",
      timedOut: false,
    });
  }
  if (path.endsWith("/prompt")) {
    return Response.json(
      {
        ok: true,
        type: "prompt.queued",
        promptId: "prompt_1",
        conversationId: "conv_1",
        status: "queued",
        promptRun: { id: "prompt_1", promptId: "prompt_1", sandboxId: "bx_1", status: "queued", done: false },
      },
      { status: 202 },
    );
  }
  if (path.endsWith("/stop")) return Response.json({ ok: true, type: "sandbox.stopped" });
  if (path.startsWith("/api/v1/sandboxes/"))
    return Response.json({ ok: true, type: "sandbox.info", sandbox: sandbox("idle") });
  throw new Error(`unexpected ${method} ${path}`);
}

function sandbox(state: string) {
  return {
    id: "bx_1",
    name: "monorepo",
    state,
    desktopAvailable: false,
    snapshotAvailable: false,
    createdAt: "2026-11-08T12:00:00.000Z",
    archiveAfter: "2026-11-08T16:00:00.000Z",
    labels: { armada: "sandbox" },
  };
}

function actor(people: { org: string; owner: string; member: string }, who: "owner" | "member"): GoldenActor {
  return { userId: people[who], orgId: people.org, role: "member" };
}

function vaultStore(db: PGlite): VaultStore {
  // Resolution runs inside the caller's transaction, where the role is `authenticated` and ciphertext
  // is unreadable. Reading it means briefly becoming the superuser again, then restoring the role.
  return createSqlVaultStore({
    async query(sql, params = []) {
      await db.exec("reset role");
      try {
        return await db.query(sql, params as never[]);
      } finally {
        await db.exec("set local role authenticated");
      }
    },
  });
}

async function seed(
  db: PGlite,
  people: { org: string },
  rows: { scope: "user" | "org"; owner: string; kind: CredentialKind; value: string }[],
): Promise<void> {
  const store = createSqlVaultStore(db);
  await store.setOrgBoatKey(people.org, await encryptSecret(BOAT_KEY, KEY));
  for (const row of rows) {
    await store.upsertCredential(row.scope, row.owner, row.kind, await encryptSecret(row.value, KEY));
  }
}

function login(userId: string, fetchImpl: typeof fetch): AuthIo {
  return {
    out: () => undefined,
    err: () => undefined,
    env: { SUPABASE_ANON_KEY: "anon-public" },
    fetch: fetchImpl,
    now: () => new Date("2026-11-08T00:00:00.000Z"),
    open: () => undefined,
    session: memorySessionStore({
      userId,
      accessToken: "access-from-login",
      refreshToken: "refresh",
      expiresAt: "2099-01-01T00:00:00.000Z",
      supabaseUrl: "https://supabase.test",
    }),
  };
}

async function fixture(db: PGlite) {
  const people = { org: crypto.randomUUID(), owner: crypto.randomUUID(), member: crypto.randomUUID() };
  for (const user of [people.owner, people.member]) {
    await db.query("insert into auth.users (id) values ($1)", [user]);
  }
  await db.query("insert into orgs (id, name) values ($1, 'Example')", [people.org]);
  await db.query(`insert into members (org_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')`, [
    people.org,
    people.owner,
    people.member,
  ]);
  await db.query(
    `insert into goldens (org_id, name, visibility, owner_id, boat_snapshot_id, config)
     values ($1, 'monorepo', 'private', $2, $3, $4::jsonb)`,
    [people.org, people.owner, SNAPSHOT, CONFIG],
  );
  return people;
}

async function asUser<T>(db: PGlite, userId: string, work: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await db.exec("set local role authenticated");
    const value = await work();
    await db.exec("commit");
    return value;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

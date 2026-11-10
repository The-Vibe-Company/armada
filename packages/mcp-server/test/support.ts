import {
  type AuthStore,
  createMemoryAuthStore,
  generateToken,
  type MemoryAuthStore,
  type OAuthServerOptions,
  sha256Hex,
} from "@armada/auth";
import type {
  AgentEvent,
  EventsRequest,
  ExecRequest,
  ExecResult,
  ForkRequest,
  Harness,
  PrepareNativeHarnessCwdRequest,
  PromptRequest,
  PromptStatus,
  Provider,
  SandboxInfo,
  SandboxState,
  SteerRequest,
} from "@armada/core";
import { createSqlVaultStore, encryptSecret, ProviderError, type Sql } from "@armada/core";
import { GoldenBuildJobs, type GoldenCreateOptions } from "@armada/core/server";
import type { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { createSqlData } from "../src/data.ts";
import { createHandler, type HandlerOptions, type Route } from "../src/http.ts";
import { sqlOver } from "../src/sql.ts";

export const PUBLIC_URL = "https://armada.example.com";
export const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, index) => index + 1)));

export const SECRETS = {
  orgBoat: "boat-org-key-0123456789",
  personalBoat: "boat-personal-key-0123456789",
  ownerClaude: "sk-ant-oat01-owner-claude-token",
  orgClaude: "sk-ant-oat01-org-claude-token",
  orgOpenai: "sk-proj-org-openai-key-0123456789",
} as const;

export interface People {
  org: string;
  otherOrg: string;
  owner: string;
  member: string;
  admin: string;
}

/** A fresh database with the migrations, two orgs, three people, three goldens and encrypted credentials. */
export async function database(): Promise<{ db: PGlite; people: People }> {
  const db = await openDatabase();
  await applyMigrations(db);
  const people: People = {
    org: crypto.randomUUID(),
    otherOrg: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    member: crypto.randomUUID(),
    admin: crypto.randomUUID(),
  };
  for (const user of [people.owner, people.member, people.admin]) {
    await db.query("insert into auth.users (id) values ($1)", [user]);
  }
  await db.query("insert into orgs (id, name, boat_api_key_enc) values ($1, 'Example', $2), ($3, 'Other', null)", [
    people.org,
    await encryptSecret(SECRETS.orgBoat, ENCRYPTION_KEY),
    people.otherOrg,
  ]);
  await db.query(
    `insert into members (org_id, user_id, role) values
      ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'admin'), ($5, $3, 'admin')`,
    [people.org, people.owner, people.member, people.admin, people.otherOrg],
  );
  const config = JSON.stringify({
    repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
    init: ["bun install"],
  });
  await db.query(
    `insert into goldens (org_id, name, visibility, owner_id, boat_snapshot_id, config) values
      ($1, 'mine', 'private', $2, $5, $8::jsonb),
      ($1, 'shared', 'org', $3, $6, $8::jsonb),
      ($4, 'elsewhere', 'org', $9, $7, $8::jsonb)`,
    [
      people.org,
      people.owner,
      people.admin,
      people.otherOrg,
      `a${"1".repeat(62)}`,
      `a${"2".repeat(62)}`,
      `a${"3".repeat(62)}`,
      config,
      people.member,
    ],
  );
  const credential = async (scope: string, owner: string, kind: string, value: string) =>
    db.query("insert into credentials (scope, owner_id, kind, value_enc) values ($1, $2, $3, $4)", [
      scope,
      owner,
      kind,
      await encryptSecret(value, ENCRYPTION_KEY),
    ]);
  await credential("user", people.owner, "claude_oauth", SECRETS.ownerClaude);
  await credential("user", people.owner, "boat", SECRETS.personalBoat);
  await credential("org", people.org, "claude_oauth", SECRETS.orgClaude);
  await credential("org", people.org, "openai", SECRETS.orgOpenai);
  return { db, people };
}

interface FakeSandbox {
  info: SandboxInfo;
  events: AgentEvent[];
  prompts: Map<string, PromptStatus>;
  env: Record<string, string>;
}

/** boat.dev in memory. Tests drive prompt statuses and events directly. */
export function fakeBoat() {
  const sandboxes = new Map<string, FakeSandbox>();
  const keys: string[] = [];
  const forks: ForkRequest[] = [];
  const preparations: PrepareNativeHarnessCwdRequest[] = [];
  const prompts: PromptRequest[] = [];
  const steers: SteerRequest[] = [];
  const execs: ExecRequest[] = [];
  const stops: string[] = [];
  let count = 0;
  let execOutput: Partial<ExecResult> = {};

  const find = (id: string): FakeSandbox => {
    const found = sandboxes.get(id);
    if (!found)
      throw new ProviderError({ provider: "fake", code: "not_found", message: "No sandbox.", retryable: false });
    return found;
  };
  const harnessFeatures = { interrupt: true, resume: true, parallelConversations: false, reasoningEffort: true };
  const extra = { fast: false, streamsPartials: true, toolEvents: true, approvals: false };

  const provider = {
    id: "boat",
    backendIdentity: async () => ({ id: "test-boat-account" }),
    harnesses: ["claude", "codex"] as Harness[],
    capabilities: {
      claude: { steer: "native", ...harnessFeatures, ...extra },
      codex: { steer: "restart", ...harnessFeatures, ...extra },
    },
    async prepareNativeHarnessCwd(request: PrepareNativeHarnessCwdRequest) {
      preparations.push(request);
    },
    async fork(request: ForkRequest) {
      forks.push(request);
      count += 1;
      const id = `bx_${count}`;
      sandboxes.set(id, {
        info: { id, name: id, state: "ready", providerState: "ready", labels: request.labels ?? {} },
        events: [],
        prompts: new Map(),
        env: request.env ?? {},
      });
      return sandboxes.get(id)?.info;
    },
    async get(id: string) {
      return find(id).info;
    },
    async exec(request: ExecRequest): Promise<ExecResult> {
      execs.push(request);
      return {
        detached: false,
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        ...execOutput,
      } as ExecResult;
    },
    async prompt(request: PromptRequest) {
      prompts.push(request);
      const sandbox = find(request.sandboxId);
      const promptId = `prompt_${prompts.length}`;
      const conversationId = request.conversationId ?? `conv_${prompts.length}`;
      sandbox.prompts.set(promptId, "running");
      sandbox.info = { ...sandbox.info, state: "running", providerState: "running" };
      sandbox.events.push({
        id: `ev_${promptId}`,
        at: prompts.length,
        kind: "prompt",
        text: request.text,
        status: "running",
        promptId,
        conversationId,
      });
      return { promptId, conversationId, status: "queued" as const };
    },
    async getPrompt(request: { sandboxId: string; promptId: string }) {
      const status = find(request.sandboxId).prompts.get(request.promptId);
      if (!status)
        throw new ProviderError({ provider: "fake", code: "not_found", message: "No prompt.", retryable: false });
      return { promptId: request.promptId, status, done: status !== "running" && status !== "queued" };
    },
    async steer(request: SteerRequest) {
      steers.push(request);
      const sandbox = find(request.sandboxId);
      const running = [...sandbox.prompts.entries()].find(([, status]) => status === "running");
      if (!running) {
        throw new ProviderError({
          provider: "fake",
          code: "no_running_turn",
          message: "Nothing runs.",
          retryable: false,
        });
      }
      return { conversationId: "conv_1", promptId: running[0], mode: "fallback" };
    },
    async interrupt() {},
    async events(request: EventsRequest) {
      const all = find(request.sandboxId).events;
      if (request.direction === "backward") {
        const end = request.cursor ? Number(request.cursor) : all.length;
        const start = Math.max(0, end - (request.limit ?? 100));
        return { events: all.slice(start, end), olderCursor: String(start), cursor: String(end), hasMore: start > 0 };
      }
      const start = request.cursor ? Number(request.cursor) : 0;
      const limit = request.limit ?? 100;
      const events = all.slice(start, start + limit);
      const end = start + events.length;
      return { events, cursor: String(end), hasMore: end < all.length };
    },
    async stop(request: { sandboxId: string }) {
      stops.push(request.sandboxId);
      const sandbox = find(request.sandboxId);
      sandbox.info = { ...sandbox.info, state: "stopped" as SandboxState, providerState: "archived" };
    },
    async delete() {
      return { status: "pending" };
    },
  } as unknown as Provider;

  return {
    provider,
    keys,
    forks,
    preparations,
    prompts,
    steers,
    execs,
    stops,
    sandbox: find,
    finish(sandboxId: string, promptId: string, status: PromptStatus) {
      const sandbox = find(sandboxId);
      sandbox.prompts.set(promptId, status);
      sandbox.info = { ...sandbox.info, state: "ready", providerState: "idle" };
    },
    setExecOutput(output: Partial<ExecResult>) {
      execOutput = output;
    },
    providerFor(key: string): Provider {
      keys.push(key);
      return provider;
    },
  };
}

export type FakeBoat = ReturnType<typeof fakeBoat>;

export interface TestServer {
  builds: GoldenBuildJobs;
  db: PGlite;
  people: People;
  boat: FakeBoat;
  auth: MemoryAuthStore;
  handler: (request: Request) => Promise<Response>;
  clock: { now: Date };
  /** A service token for this person in the org. */
  token(userId: string, orgId?: string): Promise<string>;
  /** A Supabase session token for this person, a member of these orgs (default: the org). */
  session(userId: string, orgIds?: readonly string[]): string;
  /** Signs every Supabase session out, as a sign-out or an expiry does. */
  signOut(token: string): void;
  /** Every call the server made to Supabase's user endpoint. */
  supabaseCalls: string[];
  /** Makes Supabase unreachable. */
  supabaseDown(down: boolean): void;
  client(token: string): Promise<Client>;
  github: FakeGitHub;
  close(): Promise<void>;
}

export const GITHUB_APP = { clientId: "Iv1.test", clientSecret: "github-client-secret-value" };

/** GitHub in memory: the token endpoint (rotating refresh tokens) and `/user`. */
export interface FakeGitHub {
  /** Stores a connection for this person, as the dashboard callback does. */
  connect(userId: string, login: string, githubId: number): Promise<void>;
  /** Refresh tokens GitHub was asked to refresh, in order. */
  refreshed: string[];
  /** The access tokens it handed out. */
  accessTokens: string[];
  /** Makes GitHub refuse every refresh token, as after a revocation. */
  revokeEverything(): void;
}

function fakeGitHub(db: PGlite) {
  const refreshed: string[] = [];
  const accessTokens: string[] = [];
  const users = new Map<string, { id: number; login: string }>();
  let revoked = false;
  const github: FakeGitHub = {
    async connect(userId, login, githubId) {
      users.set(`ghu_access_${login}`, { id: githubId, login });
      await db.query(
        "insert into github_connections (user_id, github_id, login, refresh_token_enc) values ($1, $2, $3, $4)",
        [userId, githubId, login, await encryptSecret(`ghr_refresh_${login}_0`, ENCRYPTION_KEY)],
      );
    },
    refreshed,
    accessTokens,
    revokeEverything() {
      revoked = true;
    },
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body)) as { refresh_token: string; client_secret: string };
      if (body.client_secret !== GITHUB_APP.clientSecret)
        return Response.json({ error: "incorrect_client_credentials" });
      refreshed.push(body.refresh_token);
      const login = /^ghr_refresh_(.+)_(\d+)$/.exec(body.refresh_token)?.[1];
      const turn = Number(/_(\d+)$/.exec(body.refresh_token)?.[1] ?? 0);
      const expected = refreshed.filter((token) => token.startsWith(`ghr_refresh_${login}_`)).length - 1;
      if (revoked || !login || turn !== expected) return Response.json({ error: "bad_refresh_token" });
      const access = `ghu_access_${login}`;
      accessTokens.push(access);
      return Response.json({
        access_token: access,
        refresh_token: `ghr_refresh_${login}_${turn + 1}`,
        expires_in: 28_800,
        refresh_token_expires_in: 15_811_200,
      });
    }
    if (url === "https://api.github.com/user") {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      const user = users.get(token);
      return user
        ? Response.json({ ...user, name: null })
        : Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (url.startsWith("https://api.github.com/user/installations")) return Response.json({ installations: [] });
    if (url === "https://api.github.com/repos/acme/web")
      return Response.json({ id: 77, name: "web", owner: { login: "acme" }, private: false, default_branch: "main" });
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;
  return { github, fetch: fetchImpl };
}

/**
 * PGlite behind the server's `Sql` adapter, with the one behaviour of production PGlite hides: Bun's
 * client does not turn a JS array into a Postgres array, so the database refuses it (22P02) unless the
 * adapter sent an array literal. Run the server on this and a raw array parameter fails as it did on Railway.
 */
export function bunLikeSql(db: PGlite, onQuery?: (text: string) => void): Sql {
  return sqlOver({
    async unsafe(text, params) {
      onQuery?.(text);
      if (params.some((param) => Array.isArray(param))) {
        throw new Error(
          'invalid input syntax for type uuid[]: Array value must start with "{" or dimension information.',
        );
      }
      return (await db.query(text, params as unknown[])).rows;
    },
  });
}

export async function harness(
  options: {
    /** The `Sql` the data, the credentials and the auth lookups run on. Default: PGlite as is. */
    sql?: (db: PGlite) => Sql;
    routes?: readonly Route[];
    buildSsh?: GoldenCreateOptions["ssh"];
    goldenAdoption?: HandlerOptions["goldenAdoption"];
    orchestrators?: HandlerOptions["orchestrators"];
    /** The store `/mcp` authenticates against. Default: the in-memory one the helpers fill. */
    authStore?: (db: PGlite) => AuthStore;
    log?: (line: string) => void;
    /** The Modal adapter, when a test configures one. Default: none, as on a server before #513. */
    modalProviderFor?: HandlerOptions["modalProviderFor"];
    providerFor?: HandlerOptions["providerFor"];
    modelAuth?: (db: PGlite) => NonNullable<HandlerOptions["modelAuth"]>;
  } = {},
): Promise<TestServer> {
  const { db, people } = await database();
  const boat = fakeBoat();
  const auth = createMemoryAuthStore();
  const clock = { now: new Date("2026-11-08T12:00:00.000Z") };
  const roles = new Map([
    [people.owner, "member"],
    [people.member, "member"],
    [people.admin, "admin"],
  ] as const);
  const oauth: OAuthServerOptions = {
    store: auth,
    fetch: async () => new Response("unexpected", { status: 500 }),
    supabaseUrl: "https://project.supabase.co",
    anonKey: "anon",
    authSecret: "a-test-auth-secret-of-enough-length",
    publicUrl: PUBLIC_URL,
    now: () => clock.now,
  };
  const sessions = new Map<string, string>();
  const supabaseCalls: string[] = [];
  let down = false;
  const supabaseFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    supabaseCalls.push(url);
    if (down) throw new TypeError("fetch failed");
    const headers = new Headers(init?.headers);
    if (url !== "https://project.supabase.co/auth/v1/user" || headers.get("apikey") !== "anon") {
      return new Response("unexpected", { status: 500 });
    }
    const userId = sessions.get(headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    if (!userId) return Response.json({ msg: "invalid JWT" }, { status: 401 });
    return Response.json({ id: userId, aud: "authenticated" });
  };
  const fakeGit = fakeGitHub(db);
  const sqlFor = (database: PGlite) => (options.sql ? options.sql(database) : database);
  const builds = new GoldenBuildJobs({
    sql: sqlFor(db),
    encryptionKey: ENCRYPTION_KEY,
    service: {
      github: {
        store: createSqlVaultStore(sqlFor(db)),
        encryptionKey: ENCRYPTION_KEY,
        app: GITHUB_APP,
        fetch: fakeGit.fetch,
      },
      installationApp: null,
      fetch: fakeGit.fetch,
      ssh: options.buildSsh ?? (async () => {}),
    },
    provider: async () => boat.provider,
  });
  const handler = createHandler({
    publicUrl: PUBLIC_URL,
    goldenBuilds: builds,
    oauth,
    authStore: options.authStore ? options.authStore(db) : auth,
    supabase: { supabaseUrl: "https://project.supabase.co", anonKey: "anon", fetch: supabaseFetch },
    data: createSqlData(options.sql ? options.sql(db) : db),
    vault: createSqlVaultStore(sqlFor(db)),
    encryptionKey: ENCRYPTION_KEY,
    github: { store: createSqlVaultStore(sqlFor(db)), app: GITHUB_APP, fetch: fakeGit.fetch },
    providerFor: options.providerFor ?? boat.providerFor,
    ...(options.modelAuth ? { modelAuth: options.modelAuth(db) } : {}),
    ...(options.goldenAdoption ? { goldenAdoption: options.goldenAdoption } : {}),
    ...(options.orchestrators ? { orchestrators: options.orchestrators } : {}),
    ...(options.modalProviderFor ? { modalProviderFor: options.modalProviderFor } : {}),
    ...(options.routes ? { routes: options.routes } : {}),
    log: options.log ?? (() => {}),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    launch: { sleep: async () => {}, sandboxPolls: 3 },
  });
  const clients: Client[] = [];
  const joined = new Set<string>();
  const join = (userId: string, orgId: string) => {
    if (joined.has(`${userId}:${orgId}`)) return;
    joined.add(`${userId}:${orgId}`);
    auth.addMembership(userId, { orgId, name: "Example", role: roles.get(userId) ?? "member" });
  };
  return {
    builds,
    db,
    people,
    boat,
    auth,
    github: fakeGit.github,
    handler,
    clock,
    async token(userId, orgId = people.org) {
      const token = generateToken("service");
      await auth.insertToken("service", {
        userId,
        orgId,
        hash: await sha256Hex(token),
        label: "test",
        createdAt: clock.now.toISOString(),
      });
      join(userId, orgId);
      return token;
    },
    session(userId, orgIds = [people.org]) {
      const token = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: userId, n: sessions.size })).replace(/=+$/, "")}.sig`;
      sessions.set(token, userId);
      for (const orgId of orgIds) join(userId, orgId);
      return token;
    },
    signOut(token) {
      sessions.delete(token);
    },
    supabaseCalls,
    supabaseDown(value) {
      down = value;
    },
    async client(token) {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
          fetch: (input, init) => handler(new Request(String(input), init)),
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      clients.push(client);
      return client;
    },
    async close() {
      for (const client of clients) await client.close();
      await db.close();
    },
  };
}

/** The structured result of a tool call, or the error text when it failed. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as { type: string; text?: string }[];
  const text = content.map((part) => part.text ?? "").join("\n");
  return {
    isError: result.isError === true,
    text,
    data: (result.structuredContent ?? {}) as Record<string, unknown>,
  };
}

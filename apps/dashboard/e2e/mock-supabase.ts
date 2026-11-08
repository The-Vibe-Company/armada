/**
 * A stand-in for Supabase Auth, PostgREST and the Armada MCP server, for the browser tests.
 * It models what the dashboard relies on: sessions by bearer token, the row level security
 * rules of supabase/migrations (private goldens, org-only keys, admin-only writes), the
 * column grant that keeps ciphertext unreadable, and the `logs` / `stop` / `send` tools.
 * The real rules are tested against Postgres in packages/core/test.
 */

type Row = Record<string, unknown>;
type Fail = { status: number; code: string; message: string };

const PORT = Number(process.env.MOCK_PORT ?? 54399);
const CODE = "123456";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ALICE = id(1);
const BOB = id(2);
const ACME = id(10);

const users = new Map<string, { id: string; email: string }>([
  [ALICE, { id: ALICE, email: "alice@example.com" }],
  [BOB, { id: BOB, email: "bob@example.com" }],
  [id(3), { id: id(3), email: "carol@example.com" }],
]);

type State = {
  orgs: Row[];
  members: Row[];
  goldens: Row[];
  sandboxes: Row[];
  credentials: Row[];
  github_connections: Row[];
  githubInstallations: Row[];
  events: Map<string, Row[]>;
  sent: string[];
  otpEmails: string[];
};

function seed(): State {
  const now = "2026-11-08T10:00:00.000Z";
  const state: State = {
    orgs: [{ id: ACME, name: "Acme", created_at: now }],
    members: [
      { org_id: ACME, user_id: ALICE, role: "admin", created_at: now },
      { org_id: ACME, user_id: BOB, role: "member", created_at: now },
    ],
    goldens: [
      golden(id(20), "shared-golden", "org", ALICE, "snap-shared"),
      golden(id(21), "alice-private", "private", ALICE, null),
      golden(id(22), "bob-private", "private", BOB, "snap-bob"),
    ],
    sandboxes: [
      sandbox(id(30), "bx_alice_running", id(20), ALICE, "claude", "running", "2026-11-08T10:05:00.000Z"),
      sandbox(id(31), "bx_alice_failed", id(20), ALICE, "codex", "failed", "2026-11-08T10:04:00.000Z"),
      sandbox(id(32), "bx_bob_secret", id(22), BOB, "claude", "ready", "2026-11-08T10:03:00.000Z"),
    ],
    credentials: [
      {
        id: id(40),
        scope: "org",
        owner_id: ACME,
        kind: "anthropic",
        value_enc: "\\x0102",
        created_at: now,
      },
    ],
    github_connections: [],
    githubInstallations: [
      {
        id: 4242,
        app_id: 8675309,
        app_slug: "armada-tvc",
        account: { login: "octocat", type: "User" },
        repository_selection: "all",
        target_type: "User",
      },
      {
        id: 9999,
        app_id: 1,
        app_slug: "someone-else",
        account: { login: "other", type: "Organization" },
        repository_selection: "selected",
        target_type: "Organization",
      },
    ],
    events: new Map(),
    sent: [],
    otpEmails: [],
  };
  state.events.set(id(30), [
    { id: "e1", at: 1_762_596_300_000, kind: "prompt", text: "Fix the failing test", status: "running" },
    {
      id: "e2",
      at: 1_762_596_310_000,
      kind: "message",
      text: "Looking at the test suite.",
      partial: false,
      tools: [{ id: "t1", name: "Bash" }],
    },
  ]);
  state.events.set(id(31), [
    {
      id: "f1",
      at: 1_762_596_240_000,
      kind: "prompt",
      text: "Refactor the parser",
      status: "failed",
      reason: "usage_limit",
    },
  ]);
  return state;
}

function golden(gid: string, name: string, visibility: string, owner: string, snapshot: string | null): Row {
  return {
    id: gid,
    org_id: ACME,
    name,
    visibility,
    owner_id: owner,
    boat_snapshot_id: snapshot,
    config: {},
    created_at: "2026-11-08T10:00:00.000Z",
  };
}

function sandbox(
  sid: string,
  boat: string,
  goldenId: string,
  owner: string,
  harness: string,
  status: string,
  createdAt: string,
): Row {
  return {
    id: sid,
    boat_id: boat,
    golden_id: goldenId,
    org_id: ACME,
    owner_id: owner,
    harness,
    status,
    conversation_ids: [],
    created_at: createdAt,
    stopped_at: null,
    deleted_at: null,
  };
}

let state = seed();
let sequence = 100;
const sessions = new Map<string, string>();

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function session(userId: string) {
  const user = users.get(userId);
  if (!user) throw new Error("unknown user");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const claims = { sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", exp };
  const access = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.mock`;
  const refresh = `refresh-${++sequence}`;
  sessions.set(access, user.id);
  sessions.set(refresh, user.id);
  return {
    access_token: access,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: exp,
    refresh_token: refresh,
    user: {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-11-08T10:00:00.000Z",
    },
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function pgError(error: Fail): Response {
  return json({ code: error.code, message: error.message, details: null, hint: null }, error.status);
}

const denied: Fail = { status: 403, code: "42501", message: "new row violates row-level security policy" };

function viewer(request: Request): string | null {
  const token = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  return token ? (sessions.get(token) ?? null) : null;
}

function isMember(orgId: unknown, userId: string): boolean {
  return state.members.some((member) => member.org_id === orgId && member.user_id === userId);
}

function isAdmin(orgId: unknown, userId: string): boolean {
  return state.members.some(
    (member) => member.org_id === orgId && member.user_id === userId && member.role === "admin",
  );
}

function canReadGolden(row: Row, userId: string): boolean {
  if (!isMember(row.org_id, userId)) return false;
  return row.visibility === "org" || row.owner_id === userId;
}

function visibleRows(table: string, userId: string): Row[] {
  switch (table) {
    case "orgs":
      return state.orgs.filter((org) => isMember(org.id, userId));
    case "members":
      return state.members.filter((member) => isMember(member.org_id, userId));
    case "goldens":
      return state.goldens.filter((row) => canReadGolden(row, userId));
    case "sandboxes":
      return state.sandboxes.filter((row) => {
        const parent = state.goldens.find((item) => item.id === row.golden_id);
        return parent ? canReadGolden(parent, userId) : false;
      });
    case "credentials":
      return state.credentials.filter((row) =>
        row.scope === "user" ? row.owner_id === userId : isMember(row.owner_id, userId),
      );
    case "github_connections":
      return state.github_connections.filter((row) => row.user_id === userId);
    default:
      return [];
  }
}

function writableRow(table: string, row: Row, userId: string): boolean {
  switch (table) {
    case "members":
      return isAdmin(row.org_id, userId);
    case "credentials":
      return row.scope === "user" ? row.owner_id === userId : isAdmin(row.owner_id, userId);
    case "github_connections":
      return row.user_id === userId;
    default:
      return false;
  }
}

function matches(row: Row, params: URLSearchParams): boolean {
  const reserved = new Set(["select", "order", "limit", "offset", "columns"]);
  for (const [key, expression] of params) {
    if (reserved.has(key)) continue;
    const dot = expression.indexOf(".");
    const op = expression.slice(0, dot);
    const operand = expression.slice(dot + 1);
    const actual = String(row[key]);
    if (op === "eq" && actual !== operand) return false;
    if (op === "neq" && actual === operand) return false;
    if (op === "in" && !operand.slice(1, -1).split(",").includes(actual)) return false;
  }
  return true;
}

function project(table: string, row: Row, select: string | null): Row | Fail {
  const columns = !select || select === "*" ? null : select.split(",").map((column) => column.trim());
  if (table === "credentials" && (!columns || columns.includes("value_enc"))) {
    if (columns?.includes("value_enc")) {
      return { status: 401, code: "42501", message: "permission denied for table credentials" };
    }
  }
  if (table === "github_connections") {
    if (!columns || columns.includes("refresh_token_enc")) {
      return { status: 401, code: "42501", message: "permission denied for table github_connections" };
    }
  }
  if (table === "orgs" && !columns) {
    return { status: 401, code: "42501", message: "permission denied for table orgs" };
  }
  if (!columns) {
    if (table === "credentials") {
      const { value_enc: _hidden, ...rest } = row;
      return rest;
    }
    return row;
  }
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}

async function rest(request: Request, url: URL): Promise<Response> {
  const userId = viewer(request);
  if (!userId) return json({ message: "JWT required", code: "PGRST301" }, 401);
  const path = url.pathname.replace("/rest/v1/", "");

  if (path.startsWith("rpc/")) return rpc(path.slice(4), await request.json(), userId);

  const table = path;
  const prefer = request.headers.get("prefer") ?? "";
  const wantRows = prefer.includes("return=representation");
  const select = url.searchParams.get("select");

  if (request.method === "GET") {
    let rows = visibleRows(table, userId).filter((row) => matches(row, url.searchParams));
    const order = url.searchParams.get("order");
    if (order) {
      const [column = "", direction = "asc"] = order.split(".");
      rows = [...rows].sort(
        (a, b) => String(a[column]).localeCompare(String(b[column])) * (direction === "desc" ? -1 : 1),
      );
    }
    const total = rows.length;
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = url.searchParams.get("limit");
    rows = rows.slice(offset, limit ? offset + Number(limit) : undefined);
    const projected = rows.map((row) => project(table, row, select));
    const failure = projected.find((row) => "status" in row && "code" in row && "message" in row) as Fail | undefined;
    if (failure) return pgError(failure);
    const range = rows.length ? `${offset}-${offset + rows.length - 1}/${total}` : `*/${total}`;
    return json(projected, 200, { "content-range": range });
  }

  if (request.method === "POST") {
    const body = (await request.json()) as Row | Row[];
    const incoming = Array.isArray(body) ? body : [body];
    const created: Row[] = [];
    for (const row of incoming) {
      if (table !== "credentials" || !writableRow(table, row, userId)) return pgError(denied);
      const dupe = state.credentials.some(
        (existing) => existing.scope === row.scope && existing.owner_id === row.owner_id && existing.kind === row.kind,
      );
      if (dupe)
        return pgError({ status: 409, code: "23505", message: "duplicate key value violates unique constraint" });
      const stored = { id: id(++sequence), created_at: new Date().toISOString(), ...row };
      state.credentials.push(stored);
      created.push(stored);
    }
    return wantRows ? json(created, 201) : new Response(null, { status: 201 });
  }

  if (request.method === "PATCH" || request.method === "DELETE") {
    const targets = visibleRows(table, userId).filter(
      (row) => matches(row, url.searchParams) && writableRow(table, row, userId),
    );
    const list = state[table as "members" | "credentials" | "github_connections"] as Row[] | undefined;
    if (!list) return pgError(denied);
    // A user JWT only selects and deletes its connection; writes go through save_github_connection.
    if (request.method === "PATCH" && table === "github_connections") return pgError(denied);
    if (request.method === "PATCH") {
      const patch = (await request.json()) as Row;
      for (const row of targets) {
        if (table === "members" && row.role === "admin" && patch.role === "member") {
          const others = state.members.some(
            (member) => member.org_id === row.org_id && member.role === "admin" && member.user_id !== row.user_id,
          );
          if (!others) return pgError({ status: 400, code: "23514", message: "an org keeps at least one admin" });
        }
        Object.assign(row, patch);
      }
    } else {
      for (const row of targets) {
        if (table === "members" && row.role === "admin") {
          const others = state.members.some(
            (member) => member.org_id === row.org_id && member.role === "admin" && member.user_id !== row.user_id,
          );
          if (!others) return pgError({ status: 400, code: "23514", message: "an org keeps at least one admin" });
        }
        list.splice(list.indexOf(row), 1);
      }
    }
    if (!wantRows) return new Response(null, { status: 204 });
    return json(targets.map((row) => project(table, row, select)));
  }

  return json({ message: "unsupported" }, 405);
}

function rpc(name: string, args: Row, userId: string): Response {
  switch (name) {
    case "create_org": {
      const orgName = String(args.org_name ?? "").trim();
      if (!orgName)
        return pgError({ status: 400, code: "23514", message: 'violates check constraint "orgs_name_chk"' });
      const org = { id: id(++sequence), name: orgName, created_at: new Date().toISOString() };
      state.orgs.push(org);
      state.members.push({ org_id: org.id, user_id: userId, role: "admin", created_at: org.created_at });
      return json(org.id);
    }
    case "org_members": {
      if (!isMember(args.target_org, userId)) return json([]);
      return json(
        state.members
          .filter((member) => member.org_id === args.target_org)
          .map((member) => ({
            user_id: member.user_id,
            email: users.get(String(member.user_id))?.email,
            role: member.role,
            created_at: member.created_at,
          })),
      );
    }
    case "add_org_member": {
      if (!isAdmin(args.target_org, userId)) {
        return pgError({ status: 403, code: "42501", message: "only an org admin adds members" });
      }
      const target = [...users.values()].find((user) => user.email === String(args.member_email).trim().toLowerCase());
      if (!target) {
        return pgError({
          status: 404,
          code: "P0002",
          message: "no account for that email: the person signs in to Armada once first",
        });
      }
      if (isMember(args.target_org, target.id)) {
        return pgError({
          status: 409,
          code: "23505",
          message: 'duplicate key value violates unique constraint "members_pkey"',
        });
      }
      state.members.push({
        org_id: args.target_org,
        user_id: target.id,
        role: args.member_role,
        created_at: new Date().toISOString(),
      });
      return json(target.id);
    }
    case "set_golden_visibility": {
      const row = state.goldens.find((item) => item.id === args.target_golden);
      if (!row || row.owner_id !== userId) return pgError({ status: 404, code: "P0002", message: "golden not found" });
      if (args.new_visibility === "org" && !isAdmin(row.org_id, userId)) {
        return pgError({ status: 403, code: "42501", message: "only an org admin shares a golden with the org" });
      }
      row.visibility = args.new_visibility;
      return new Response(null, { status: 204 });
    }
    case "save_github_connection": {
      const now = new Date().toISOString();
      const row = {
        user_id: userId,
        github_id: args.github_user_id,
        login: args.github_login,
        name: args.github_name,
        refresh_token_enc: args.token_enc,
        refresh_expires_at: args.token_expires_at,
        installations: args.installation_list ?? null,
        revoked_at: null,
        updated_at: now,
      };
      const existing = state.github_connections.find((item) => item.user_id === userId);
      if (existing) Object.assign(existing, row);
      else state.github_connections.push({ ...row, created_at: now });
      return new Response(null, { status: 204 });
    }
    default:
      return json({ message: `unknown function ${name}` }, 404);
  }
}

function auth(request: Request, url: URL, body: Row): Response {
  const path = url.pathname.replace("/auth/v1", "");
  if (path === "/otp") {
    state.otpEmails.push(String(body.email));
    return json({});
  }
  if (path === "/verify") {
    const email = String(body.email ?? "").toLowerCase();
    const user = [...users.values()].find((candidate) => candidate.email === email);
    if (!user || body.token !== CODE)
      return json({ code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" }, 403);
    return json(session(user.id));
  }
  if (path === "/token") {
    const owner = sessions.get(String(body.refresh_token));
    return owner ? json(session(owner)) : json({ code: 400, msg: "Invalid Refresh Token" }, 400);
  }
  if (path === "/user") {
    const userId = viewer(request);
    const user = userId ? users.get(userId) : undefined;
    if (!user) return json({ code: 401, msg: "invalid JWT" }, 401);
    return json({
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-11-08T10:00:00.000Z",
    });
  }
  if (path === "/logout") return new Response(null, { status: 204 });
  return json({ msg: "not found" }, 404);
}

type RpcMessage = { id?: number; method: string; params?: Record<string, unknown> };

function mcp(message: RpcMessage, userId: string | null): Response {
  if (!userId) return json({ error: "unauthorized" }, 401);
  const reply = (result: unknown) => json({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "0" },
      },
    });
  }
  if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (message.method !== "tools/call") return reply({});

  const args = (message.params?.arguments ?? {}) as Row;
  const target = state.sandboxes.find((row) => row.id === args.id);
  const visible = visibleRows("sandboxes", userId).some((row) => row === target);
  const text = (value: unknown, isError = false) =>
    reply({ content: [{ type: "text", text: JSON.stringify(value) }], isError });
  if (!target || !visible) return text("not found", true);

  switch (message.params?.name) {
    case "logs": {
      const events = state.events.get(String(target.id)) ?? [];
      const since = typeof args.since_cursor === "string" ? Number(args.since_cursor) : 0;
      return text({ events: events.slice(since), cursor: String(events.length), hasMore: false });
    }
    case "send": {
      state.sent.push(String(args.prompt));
      const events = state.events.get(String(target.id)) ?? [];
      events.push({
        id: `sent-${events.length}`,
        at: Date.now(),
        kind: "prompt",
        text: String(args.prompt),
        status: "queued",
      });
      state.events.set(String(target.id), events);
      return text({ ok: true });
    }
    case "stop":
      target.status = "stopped";
      target.stopped_at = new Date().toISOString();
      return text({ ok: true });
    default:
      return text("unknown tool", true);
  }
}

/** GitHub's token and user endpoints, reached by the app server through e2e/github-fetch.cjs. */
function github(request: Request, url: URL, body: Row): Response {
  if (url.pathname === "/github/login/oauth/access_token") {
    if (body.client_id !== "Iv1.e2e" || body.client_secret !== "e2e-client-secret") {
      return json({ error: "incorrect_client_credentials" });
    }
    if (body.code !== "good-code") return json({ error: "bad_verification_code" });
    return json({
      access_token: "ghu_e2e_access",
      expires_in: 28_800,
      refresh_token: "ghr_e2e_refresh",
      refresh_token_expires_in: 15_897_600,
    });
  }
  if (url.pathname === "/github/user") {
    if (request.headers.get("authorization") !== "Bearer ghu_e2e_access")
      return json({ message: "Bad credentials" }, 401);
    return json({ id: 583231, login: "octocat", name: "Octo Cat" });
  }
  if (url.pathname === "/github/user/installations") {
    if (request.headers.get("authorization") !== "Bearer ghu_e2e_access")
      return json({ message: "Bad credentials" }, 401);
    return json({ total_count: state.githubInstallations.length, installations: state.githubInstallations });
  }
  return json({ message: "not found" }, 404);
}

function control(url: URL, body: Row): Response {
  if (url.pathname === "/__test/reset") {
    state = seed();
    if (body.multiOrg) {
      const now = "2026-11-08T10:00:00.000Z";
      state.orgs.push({ id: id(11), name: "Zenith", created_at: now });
      state.members.push({ org_id: id(11), user_id: ALICE, role: "member", created_at: now });
      state.goldens.push({ ...golden(id(23), "zenith-golden", "org", ALICE, "snap-zenith"), org_id: id(11) });
      state.sandboxes.push({ ...sandbox(id(33), "bx_zenith", id(23), ALICE, "codex", "ready", now), org_id: id(11) });
      state.credentials.push({
        id: id(41),
        scope: "org",
        owner_id: id(11),
        kind: "boat",
        value_enc: "\\x0102",
        created_at: now,
      });
    }
    sessions.clear();
    return json({ ok: true });
  }
  if (url.pathname === "/__test/remove-zenith-membership") {
    state.members = state.members.filter((row) => row.org_id !== id(11));
    return json({ ok: true });
  }
  if (url.pathname === "/__test/append-event") {
    const events = state.events.get(String(body.sandbox)) ?? [];
    events.push({
      id: `live-${events.length}`,
      at: Date.now(),
      kind: "message",
      text: String(body.text),
      partial: false,
      tools: [],
    });
    state.events.set(String(body.sandbox), events);
    return json({ ok: true });
  }
  if (url.pathname === "/__test/credentials") {
    return json(state.credentials.map((row) => ({ ...row })));
  }
  if (url.pathname === "/__test/github-connect") {
    state.github_connections.push({
      user_id: String(body.user),
      github_id: 583231,
      login: String(body.login),
      name: "Octo Cat",
      refresh_token_enc: "\\x0102",
      refresh_expires_at: null,
      installations: body.installations ?? null,
      revoked_at: body.revoked ? "2026-11-08T11:00:00.000Z" : null,
      created_at: "2026-11-08T10:00:00.000Z",
      updated_at: "2026-11-08T10:00:00.000Z",
    });
    return json({ ok: true });
  }
  if (url.pathname === "/__test/github-installations") {
    state.githubInstallations = Array.isArray(body.installations) ? (body.installations as Row[]) : [];
    return json({ ok: true });
  }
  if (url.pathname === "/__test/github-connections") {
    return json(state.github_connections.map((row) => ({ ...row })));
  }
  if (url.pathname === "/__test/state") {
    return json({ otpEmails: state.otpEmails, sent: state.sent });
  }
  return json({ message: "not found" }, 404);
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.method !== "DELETE";
    if (url.pathname.startsWith("/rest/v1/")) return rest(request, url);
    const text = hasBody ? await request.text() : "";
    const body = text ? (JSON.parse(text) as Row) : {};
    if (url.pathname.startsWith("/auth/v1/")) return auth(request, url, body);
    if (url.pathname.startsWith("/__test/")) return control(url, body);
    if (url.pathname === "/mcp") return mcp(body as unknown as RpcMessage, viewer(request));
    if (url.pathname.startsWith("/api/v1/")) {
      const route = url.pathname.slice("/api/v1/".length);
      if (route === "auth/email/start") return json({ ok: true });
      if (route === "golden/list")
        return request.headers.get("authorization") ? json({ goldens: [] }) : json({ error: "Unauthorized." }, 401);
      return json({ error: "Not found." }, 404);
    }
    if (url.pathname.startsWith("/github/")) return github(request, url, body);
    if (url.pathname === "/health") return json({ ok: true });
    return json({ message: "not found" }, 404);
  },
});

console.log(`mock supabase listening on ${server.port}`);

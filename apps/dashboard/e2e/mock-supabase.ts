import { type MachineSizePolicy, resolveMachineSize } from "@armada/core";

/**
 * A stand-in for Supabase Auth, PostgREST and the Armada MCP server, for the browser tests.
 * It models what the dashboard relies on: sessions by bearer token, the row level security
 * rules of supabase/migrations (private goldens, org-only keys, admin-only writes), the
 * column grant that keeps ciphertext unreadable, the `logs` / `stop` / `send` / `launch` tools, the MCP
 * connection control API with its write-only authentication, and an upstream OAuth consent page.
 * The real rules are tested against Postgres in packages/core/test.
 */

import { credsList, orchestratorRoute, orchestratorTestControl } from "./mock-orchestrators";

type Row = Record<string, unknown>;
type Fail = { status: number; code: string; message: string };

const PORT = Number(process.env.MOCK_PORT ?? 54399);
const CODE = "123456";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ALICE = id(1);
const BOB = id(2);
const ACME = id(10);
const ORION = id(13);

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
  /** The arguments of every send, steer and interrupt, as the dashboard serialized them. */
  toolCalls: { name: string; args: Row }[];
  /** The next send, steer or interrupt fails with this message, once. */
  failNextTool: string | null;
  /** Every CLI GitHub callback the dashboard relayed, with the credentials headers it carried (none expected). */
  githubCliCalls: { body: Row; authorization: string | null; cookie: string | null }[];
  /** Every launch body that reached allocation, as the dashboard sent it. */
  launches: Row[];
  /** The route of each of `launches`, in order. */
  launchRoutes: string[];
  /** Golden build and capability requests contain metadata only, never tokens. */
  goldenCalls: { route: string; body: Row; authorized: boolean }[];
  goldenGate: {
    hold: boolean;
    fail: { status: number; code?: string; message: string } | null;
    /** The job is admitted, then a gateway in front of the server loses the answer (a 504 without a code). */
    loseAnswer?: boolean;
    /** Status reads fail (a 503) while set; the jobs themselves are unaffected. */
    failStatus?: boolean;
  };
  /** Every `golden/size-policy` body (#653), as the dashboard sent it. */
  sizePolicyCalls: Row[];
  /** A launch asking for this size is refused by the provider, as Boat refuses a plan-gated size. */
  refuseSize: string | null;
  /** The database has #653's columns but the server predates it: `size` is ignored and its routes are unknown. */
  olderServer: boolean;
  /** Sized launches refused before allocation (an older replica's 404, a missing version's 400). */
  sizedRefusals: Row[];
  /** Every `golden/remove` body, as the dashboard sent it, and whether it carried a session. */
  goldenRemoveCalls: { body: Row; authorized: boolean }[];
  /** Every `golden/build/status` body, as the dashboard sent it. */
  goldenStatusCalls: Row[];
  capabilityCalls: { body: Row; authorized: boolean }[];
  /** Per provider: the limit the server reads for the org, or why it cannot (such as not configured). */
  capabilities: Record<
    "boat" | "modal",
    {
      maxGoldens: number | null;
      bindings?: Row[] | null | undefined;
      fail: { status: number; code?: string; message: string } | null;
    }
  >;
  otpEmails: string[];
  /** The registry's connections. `authentication` is the write-only value; no response ever includes it. */
  connections: Row[];
  /** Every control API call, with its operation and body, for the tests to check what the dashboard sent. */
  controlCalls: { operation: string; body: Row }[];
  /** Every `org/provider/*` call (#576): its route, the body as sent and whether it carried a session. */
  providerCalls: { route: string; body: Row; authorized: boolean }[];
  /** While set, `org/provider/status` answers this failure instead of the stored state; `html` is an edge page body. */
  providerStatusFail: { status: number; code?: string; message: string; html?: string } | null;
  /** Organization invitations (#640 contract v1). `token` is what the email link carries; no response includes it. */
  invitations: Row[];
  /** The delivery state the next create or resend records: what the mail transport answered. */
  nextDelivery: "not_configured" | "pending" | "sent" | "failed";
  /** Every `org/invitations/*` call: its route, the body as sent and whether it carried a session. */
  invitationCalls: { route: string; body: Row; authorized: boolean }[];
  /** Accounts whose email address is not verified yet. */
  unverifiedEmails: string[];
  /** GoTrue calls that establish or check an identity (`/verify`, `/token`, `/user`), in order. */
  authCalls: string[];
};

function seed(): State {
  const now = "2026-11-08T10:00:00.000Z";
  const state: State = {
    // Acme's Boat key predates org credentials: the legacy `orgs.boat_api_key_enc` column, never readable by a user JWT.
    orgs: [{ id: ACME, name: "Acme", created_at: now, boat_api_key_enc: "\\x0102" }],
    members: [
      { org_id: ACME, user_id: ALICE, role: "admin", created_at: now },
      { org_id: ACME, user_id: BOB, role: "member", created_at: now },
    ],
    goldens: [
      {
        ...golden(id(20), "shared-golden", "org", ALICE, "snap-shared"),
        config: {
          repos: [
            { url: "https://github.com/acme/web.git", branch: "main", dir: "web" },
            { url: "https://github.com/acme/api.git", branch: "main", dir: "api" },
          ],
          init: [],
        },
      },
      golden(id(21), "alice-private", "private", ALICE, null),
      golden(id(22), "bob-private", "private", BOB, "snap-bob"),
      { ...golden(id(26), "modal-golden", "org", ALICE, "snap-modal"), provider: "modal", boat_snapshot_id: null },
    ],
    sandboxes: [
      sandbox(id(30), "bx_alice_running", id(20), ALICE, "claude", "running", "2026-11-08T10:05:00.000Z"),
      // On Modal, as its golden: the list names the provider from this column, never from the ID (#645).
      {
        ...sandbox(id(31), "bx_alice_failed", id(26), ALICE, "codex", "failed", "2026-11-08T10:04:00.000Z"),
        provider: "modal",
        boat_id: null,
      },
      {
        ...sandbox(id(32), "bx_bob_secret", id(22), BOB, "claude", "ready", "2026-11-08T10:03:00.000Z"),
        visibility: "private",
      },
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
    toolCalls: [],
    failNextTool: null,
    launches: [],
    goldenCalls: [],
    goldenRemoveCalls: [],
    goldenStatusCalls: [],
    goldenGate: { hold: false, fail: null },
    capabilityCalls: [],
    // A Boat account holds one golden; Modal is unbounded.
    capabilities: { boat: { maxGoldens: 1, fail: null }, modal: { maxGoldens: null, fail: null } },
    githubCliCalls: [],
    otpEmails: [],
    invitations: [],
    nextDelivery: "sent",
    invitationCalls: [],
    unverifiedEmails: [],
    authCalls: [],
    connections: [
      mcpConnection(id(60), "Acme Docs", ACME, "org", ALICE, {
        url: "https://docs.acme.test/mcp",
        authType: "none",
        status: "connected",
        toolCount: 12,
        resourceCount: 3,
        promptCount: 2,
      }),
      mcpConnection(id(61), "Alice Linear", ACME, "personal", ALICE, {
        url: "https://mcp.linear.app/mcp",
        catalogId: "linear",
        defaultForLaunch: true,
        authType: "oauth",
        status: "connected",
        accountLabel: "alice@linear.test",
        toolCount: 21,
        resourceCount: 0,
        promptCount: 1,
      }),
      mcpConnection(id(62), "Bob Notes", ACME, "personal", BOB, {
        url: "https://notes.test/mcp",
        authType: "bearer",
        status: "connected",
        authentication: "bob-token",
      }),
      mcpConnection(id(65), "Repo Files", ACME, "personal", ALICE, {
        transport: "stdio",
        command: "uvx",
        args: ["mcp-server-git==2026.1.14"],
        authType: "none",
        // Saved before the registry configured stdio definitions on save.
        status: "not_connected",
      }),
      mcpConnection(id(66), "Acme Search", ACME, "org", ALICE, {
        url: "https://search.acme.test/mcp",
        authType: "none",
        status: "unavailable",
        lastError: "The server did not answer.",
      }),
      mcpConnection(id(63), "Acme Sentry", ACME, "org", ALICE, {
        url: "https://sentry.test/mcp",
        authType: "oauth",
        status: "needs_reconnect",
        lastError: "The refresh token was revoked upstream. Reconnect to sign in again.",
      }),
    ],
    controlCalls: [],
    providerCalls: [],
    sizePolicyCalls: [],
    refuseSize: null,
    olderServer: false,
    sizedRefusals: [],
    launchRoutes: [],
    providerStatusFail: null,
  };
  // The org golden records two repositories, so its launch form offers a working directory.
  const shared = state.goldens[0];
  if (shared)
    shared.config = {
      repos: [
        { url: "https://github.com/acme/web.git", branch: "main", dir: "web" },
        { url: "https://github.com/acme/api.git", branch: "develop", dir: "api" },
      ],
      init: ["bun install"],
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

function mcpConnection(
  cid: string,
  name: string,
  orgId: string,
  scope: "personal" | "org",
  owner: string,
  fields: Row,
): Row {
  return { id: cid, name, orgId, scope, owner, transport: "http", defaultForLaunch: false, ...fields };
}

function golden(gid: string, name: string, visibility: string, owner: string, snapshot: string | null): Row {
  return {
    id: gid,
    org_id: ACME,
    name,
    visibility,
    owner_id: owner,
    provider: "boat",
    boat_snapshot_id: snapshot,
    provider_snapshot_id: snapshot,
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
    provider: "boat",
    boat_id: boat,
    provider_sandbox_id: boat,
    golden_id: goldenId,
    org_id: ACME,
    owner_id: owner,
    harness,
    status,
    conversation_ids: [],
    // Recorded at launch (sandboxes.visibility); independent of the golden's.
    visibility: "org",
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

/** The goldens the server acts on (launch, rebuild, remove): visible and not removed. */
function liveGoldens(userId: string): Row[] {
  return visibleRows("goldens", userId).filter((row) => !row.removed_at);
}

function visibleRows(table: string, userId: string): Row[] {
  switch (table) {
    case "orgs":
      return state.orgs.filter((org) => isMember(org.id, userId));
    case "members":
      return state.members.filter((member) => isMember(member.org_id, userId));
    case "goldens":
      // As in the #566 migration, a removed golden stays readable (a tombstone its sandboxes still join to); a list
      // that should not show it filters `removed_at=is.null` itself.
      return state.goldens.filter((row) => canReadGolden(row, userId));
    case "sandboxes":
      return state.sandboxes.filter((row) => {
        if (row.visibility === "private" && row.owner_id !== userId) return false;
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
    if (op === "is" && operand === "null" && row[key] !== null && row[key] !== undefined) return false;
    if (op === "not" && operand === "is.null" && (row[key] === null || row[key] === undefined)) return false;
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
      // `credentials_org_boat_chk` (#586): the org Boat key is the org's column, never a row.
      if (row.scope === "org" && row.kind === "boat")
        return pgError({ status: 400, code: "23514", message: "violates check constraint credentials_org_boat_chk" });
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
  if (path === "/verify" || path === "/token" || path === "/user") state.authCalls.push(path);
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
  const name = String(message.params?.name);
  const driving = name === "send" || name === "steer" || name === "interrupt";
  if (driving) state.toolCalls.push({ name, args });
  const target = state.sandboxes.find((row) => row.id === args.id);
  const visible = visibleRows("sandboxes", userId).some((row) => row === target);
  const text = (value: unknown, isError = false) =>
    reply({ content: [{ type: "text", text: JSON.stringify(value) }], isError });
  if (!target || !visible) return text("not found", true);
  if (driving && state.failNextTool) {
    const failure = state.failNextTool;
    state.failNextTool = null;
    return reply({ content: [{ type: "text", text: failure }], isError: true });
  }
  const events = state.events.get(String(target.id)) ?? [];
  state.events.set(String(target.id), events);
  const conversations = (target.conversation_ids ?? []) as string[];

  switch (message.params?.name) {
    case "logs": {
      const since = typeof args.since_cursor === "string" ? Number(args.since_cursor) : 0;
      return text({ events: events.slice(since), cursor: String(events.length), hasMore: false });
    }
    case "send": {
      // As the server does: the named conversation, else the latest, else a new one; the sandbox is running after.
      state.sent.push(String(args.prompt));
      const conversationId =
        typeof args.conversation_id === "string"
          ? args.conversation_id
          : (conversations.at(-1) ?? `conv-${events.length}`);
      if (!conversations.includes(conversationId)) target.conversation_ids = [...conversations, conversationId];
      target.status = "running";
      const promptId = `sent-${events.length}`;
      events.push({
        id: promptId,
        at: Date.now(),
        kind: "prompt",
        text: String(args.prompt),
        status: "running",
        conversationId,
        promptId,
      });
      return text({ id: target.id, promptId, conversationId, status: "running" });
    }
    case "steer": {
      const conversationId = typeof args.conversation_id === "string" ? args.conversation_id : conversations.at(-1);
      events.push({
        id: `steer-${events.length}`,
        at: Date.now(),
        kind: "steer",
        text: String(args.text),
        conversationId,
      });
      const delivery = target.harness === "codex" ? "restart" : "native";
      return text({ id: target.id, promptId: "steered", conversationId, delivery, mode: null });
    }
    case "interrupt": {
      const running = [...events]
        .reverse()
        .find(
          (event) =>
            event.kind === "prompt" && event.status === "running" && event.conversationId === args.conversation_id,
        );
      if (running)
        events.push({ ...running, id: `interrupted-${events.length}`, at: Date.now(), status: "interrupted" });
      return text({ id: target.id, interrupted: true });
    }
    case "stop":
      target.status = "stopped";
      target.stopped_at = new Date().toISOString();
      return text({ ok: true });
    default:
      return text("unknown tool", true);
  }
}

/**
 * `POST /api/v1/sandbox/launch`, as the Armada API serves it: the golden must be visible in the org, `repo` must be
 * exactly one of its `config.repos[].dir`, and a personal connection needs a private sandbox. The sandbox row
 * records what was launched, including `repository_dir`.
 */
function launchRoute(body: Row, userId: string | null, route = "sandbox/launch"): Response {
  if (!userId) return controlFail(401, "unauthorized", "Sign in again.");
  state.launches.push(body);
  state.launchRoutes.push(route);
  const source = liveGoldens(userId).find(
    (row) => row.name === body.golden && row.provider === body.provider && row.org_id === body.org,
  );
  if (!source) return controlFail(404, "not_found", "No such golden.");
  if (body.harness !== "claude" && body.harness !== "codex") {
    return controlFail(400, "invalid", "The agent is claude or codex.");
  }
  const dirs = ((source.config as { repos?: { dir?: string }[] }).repos ?? []).map((repo) => repo.dir);
  if (body.repo !== undefined && !dirs.includes(String(body.repo))) {
    return controlFail(400, "invalid", "That repository is not in the golden.");
  }
  const sized = "size_policy" in source && !state.olderServer;
  if (sized && body.size !== undefined && !SIZES.includes(String(body.size)))
    return controlFail(400, "invalid_request", "Size must be small, medium, large or xlarge.");
  // As the server maps Boat's `machine_class_plan_required` ProviderError: 403 forbidden, nothing allocated.
  if (sized && body.size !== undefined && body.size === state.refuseSize)
    return controlFail(403, "forbidden", "Requested size cannot be allocated.");
  const ids = Array.isArray(body.connections) ? body.connections.map(String) : [];
  for (const cid of ids) {
    const connection = visibleConnections(String(body.org), userId).find((row) => row.id === cid);
    if (!connection) return controlFail(404, "not_found", "A connection is not available.");
    if (connection.scope === "personal" && body.visibility !== "private") {
      return controlFail(400, "invalid", "A personal connection needs a private sandbox.");
    }
  }
  const row = sandbox(
    crypto.randomUUID(),
    `bx_launched_${++sequence}`,
    String(source.id),
    userId,
    String(body.harness),
    body.prompt ? "running" : "ready",
    new Date().toISOString(),
  );
  row.model = body.model;
  row.reasoning_effort = body.reasoningEffort;
  row.visibility = body.visibility;
  row.connections = ids;
  row.repository_dir = body.repo ?? null;
  // The producer's own resolution, as the server records it; an older server records nothing.
  const machineSize = sized
    ? resolveMachineSize(
        source.provider as "boat" | "modal",
        body.size,
        (body.repo as string | undefined) ?? null,
        source.size_policy as MachineSizePolicy | null,
      )
    : null;
  row.provider = source.provider;
  if ("size_policy" in source) row.machine_size = machineSize;
  state.sandboxes.unshift(row);
  return json({
    sandbox: {
      id: row.id,
      boatId: row.boat_id,
      repositoryDir: row.repository_dir,
      // An older server answers no `machineSize` key at all.
      ...(sized ? { machineSize } : {}),
    },
  });
}

/* The registry's control API (issue #522): POST /api/v1/mcp/<operation>, user JWT as the bearer. */

const DASHBOARD = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:3100";
const OAUTH_HOST = "oauth.test";
const ISSUER = `http://127.0.0.1:${PORT}`;
/** Pending browser sign-ins by state: the API, not the URL, knows which user and connection a state is for. */
let failSandboxConnections = false;
const pendingOAuth = new Map<string, { connection: string; user: string; code: string | null }>();

function visibleConnections(orgId: string, userId: string): Row[] {
  if (!isMember(orgId, userId)) return [];
  return state.connections.filter((row) => row.orgId === orgId && (row.scope === "org" || row.owner === userId));
}

/** The public DTO: every field but the owner and the write-only authentication. */
function connectionDto(row: Row): Row {
  const { owner: _owner, authentication: _secret, statusBeforeDisable: _previous, ...dto } = row;
  return dto;
}

const invitationDto = (row: Row) => {
  const { token: _token, ...dto } = row;
  return dto;
};

/**
 * `org/invitations/{create,list,resend,revoke,accept}`, as #640's control API v1 serves them: admin-only management,
 * a fresh token on every send (a resend invalidates the previous link), and an accept bound to the signed-in user's
 * email, single-use, that adds the membership only then. Delivery is whatever the test set the transport to answer.
 */
function invitations(route: string, body: Row, request: Request): Response {
  const userId = viewer(request);
  state.invitationCalls.push({ route, body, authorized: Boolean(userId) });
  if (!userId) return controlFail(401, "unauthorized", "Sign in.");
  const fresh = () => `mock-invitation-${++sequence}-0123456789abcdef`;
  if (route === "preview" || route === "accept") {
    const row = state.invitations.find((item) => item.token === body.token);
    const email = users.get(userId)?.email;
    // The server's order: the address must match before anything about the org is said. The first failing check wins.
    const checks: [boolean, string][] = [
      [!row, "not_found"],
      [row?.email !== email, "wrong_email"],
      [state.unverifiedEmails.includes(String(email)), "unverified_email"],
      [row?.status === "revoked", "revoked"],
      [row?.status === "accepted", "used"],
      [Date.parse(String(row?.expiresAt)) <= Date.now(), "expired"],
      [Boolean(row) && isMember(row?.orgId, userId), "already_member"],
    ];
    const reason = checks.find(([failed]) => failed)?.[1] ?? null;
    if (route === "preview") {
      const named = row && reason !== "not_found" && reason !== "wrong_email" && reason !== "unverified_email";
      const org = named ? state.orgs.find((item) => item.id === row.orgId) : null;
      return json({
        state: reason ?? "ready",
        context: org ? { orgId: org.id, orgName: org.name, role: row?.role, expiresAt: row?.expiresAt } : null,
      });
    }
    if (reason || !row) {
      const refusal: Record<string, [number, string]> = {
        wrong_email: [403, "forbidden"],
        unverified_email: [403, "forbidden"],
        used: [409, "conflict"],
        already_member: [409, "conflict"],
      };
      const [status, code] = refusal[String(reason)] ?? [404, "not_found"];
      return json({ error: { code, message: "The invitation cannot be accepted.", reason } }, status);
    }
    row.status = "accepted";
    state.members.push({ org_id: row.orgId, user_id: userId, role: row.role, created_at: new Date().toISOString() });
    return json({ orgId: row.orgId, accepted: true });
  }
  const org = state.orgs.find((item) => item.id === body.org);
  if (!org || !isAdmin(org.id, userId)) return controlFail(403, "forbidden", "Only an org admin manages invitations.");
  if (route === "list")
    return json({ invitations: state.invitations.filter((row) => row.orgId === org.id).map(invitationDto) });
  if (route === "create") {
    const email = String(body.email ?? "").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email) || (body.role !== "member" && body.role !== "admin"))
      return controlFail(400, "invalid", "An invitation needs an email and a role.");
    const member = [...users.values()].find((user) => user.email === email);
    if (member && isMember(org.id, member.id))
      return json(
        { error: { code: "conflict", message: `${email} is already a member.`, reason: "already_member" } },
        409,
      );
    if (state.invitations.some((row) => row.orgId === org.id && row.email === email && row.status === "pending"))
      return json(
        {
          error: {
            code: "conflict",
            message: `${email} already has a pending invitation. Resend it instead.`,
            reason: "pending_exists",
          },
        },
        409,
      );
    const row: Row = {
      id: id(++sequence),
      orgId: org.id,
      email,
      role: body.role,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      status: "pending",
      delivery: state.nextDelivery,
      token: fresh(),
    };
    state.invitations.push(row);
    return json({ invitation: invitationDto(row) });
  }
  const row = state.invitations.find((item) => item.id === body.id && item.orgId === org.id);
  if (row?.status !== "pending") return controlFail(404, "not_found", "Invitation not found.");
  if (route === "resend") {
    row.token = fresh();
    row.delivery = state.nextDelivery;
    return json({ invitation: invitationDto(row) });
  }
  if (route === "revoke") {
    row.status = "revoked";
    return json({ invitation: invitationDto(row) });
  }
  return controlFail(404, "not_found", "Unknown route.");
}

function controlFail(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** The probe a real broker runs: auto resolves to OAuth for an OAuth host and to public otherwise. */
function probe(row: Row): string | null {
  if (row.transport === "stdio") {
    // Configuring a stdio server checks its definition; the process only ever starts inside a sandbox.
    row.status = "connected";
    return null;
  }
  const url = new URL(String(row.url));
  const needsOAuth = url.hostname.endsWith(OAUTH_HOST);
  if (row.authType === "auto") row.authType = needsOAuth ? "oauth" : "none";
  if (row.authType === "oauth") {
    if (row.status !== "needs_reconnect") row.status = "not_connected";
    const pending = crypto.randomUUID().replaceAll("-", "");
    pendingOAuth.set(pending, { connection: String(row.id), user: String(row.owner), code: null });
    return `${ISSUER}/oauth/authorize?state=${pending}`;
  }
  if (row.authType === "bearer" && row.authentication !== "good-token") {
    row.status = "needs_reconnect";
    row.lastError = "The server refused the token (401).";
    return null;
  }
  row.status = "connected";
  delete row.lastError;
  Object.assign(row, { toolCount: 4, resourceCount: 1, promptCount: 0 });
  return null;
}

/** The registry's complete McpConnectionInput check, for create and for the full-replace update. */
function invalidDefinition(body: Row): string | null {
  if (body.scope !== "personal" && body.scope !== "org") return "scope is required.";
  if (typeof body.name !== "string" || !body.name.trim()) return "name is required.";
  if (!["http", "sse", "stdio"].includes(String(body.transport))) return "transport is required.";
  if (!["auto", "none", "bearer", "headers", "oauth"].includes(String(body.authType))) return "authType is required.";
  if (!Array.isArray(body.args) || !body.args.every((arg) => typeof arg === "string")) return "args is required.";
  if (body.transport === "stdio") {
    if (typeof body.command !== "string" || !body.command) return "command is required for stdio.";
    if (body.url !== undefined) return "A stdio connection has no url.";
    if (body.authType !== "none" || body.authentication !== undefined) {
      return "stdio connections support no authentication.";
    }
    return null;
  }
  if (typeof body.url !== "string" || !body.url.startsWith("http")) return "url is required for http and sse.";
  if (body.command !== undefined) return "A remote connection has no command.";
  return null;
}

function definitionFields(body: Row): Row {
  return {
    name: body.name,
    transport: body.transport,
    authType: body.authType,
    ...(body.transport === "stdio" ? { command: body.command, args: body.args } : { url: body.url }),
    ...(body.authentication ? { authentication: body.authentication } : {}),
  };
}

/**
 * The curated services, as `POST mcp/catalog` reports them for this deployment (issue #601, `MCP_CATALOG` in
 * `@armada/core`). Slack's MCP server needs a registered confidential client, which this deployment has not.
 */
const CATALOG = [
  {
    id: "notion",
    label: "Notion",
    url: "https://mcp.notion.com/mcp",
    docsUrl: "https://developers.notion.com/guides/mcp/overview",
    availability: "available",
  },
  {
    id: "linear",
    label: "Linear",
    url: "https://mcp.linear.app/mcp",
    docsUrl: "https://linear.app/docs/mcp",
    availability: "available",
  },
  {
    id: "slack",
    label: "Slack",
    url: "https://mcp.slack.com/mcp",
    docsUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
    availability: "setup_required",
    setupMessage: "Registered confidential OAuth client required; not configured on this deployment.",
  },
];
let failCatalog = false;
let failConnect = false;

function mcpControl(operation: string, body: Row, userId: string | null): Response {
  if (!userId) return controlFail(401, "unauthorized", "Sign in again.");
  state.controlCalls.push({ operation, body });
  if (operation === "oauth/callback") return oauthCallback(body, userId);
  const org = String(body.org ?? "");
  if (!isMember(org, userId)) return controlFail(403, "forbidden", "You are not a member of that organization.");
  if (operation === "list") return json({ connections: visibleConnections(org, userId).map(connectionDto) });
  if (operation === "catalog") {
    if (failCatalog) return controlFail(404, "not_found", "Unknown route.");
    return json({ services: CATALOG });
  }
  if (operation === "sandbox-connections") {
    if (failSandboxConnections) return controlFail(503, "unavailable", "The registry is unavailable.");
    const sandboxRow = visibleRows("sandboxes", userId).find((item) => item.id === body.id && item.org_id === org);
    if (!sandboxRow) return controlFail(404, "not_found", "That sandbox does not exist.");
    const bound = Array.isArray(sandboxRow.connections) ? sandboxRow.connections.map(String) : [];
    const visible = visibleConnections(org, userId).filter((item) => bound.includes(String(item.id)));
    return json({ connections: visible.map(connectionDto) });
  }
  if (operation === "create") {
    if (body.scope === "org" && !isAdmin(org, userId)) {
      return controlFail(403, "forbidden", "Only an org admin adds org connections.");
    }
    if (visibleConnections(org, userId).some((row) => row.name === body.name && row.scope === body.scope)) {
      return controlFail(409, "conflict", "A connection with that name already exists.");
    }
    if (body.serviceId !== undefined) {
      // The server resolves the service to its canonical URL and sign-in; the client sends nothing else.
      const service = CATALOG.find((item) => item.id === body.serviceId);
      if (!service) return controlFail(400, "invalid", "Unknown service.");
      if (service.availability !== "available") return controlFail(400, "setup_required", "That service needs setup.");
      const extra = Object.keys(body).filter((key) => !["org", "scope", "name", "serviceId"].includes(key));
      if (extra.length) return controlFail(400, "invalid", `Unexpected ${extra.join(", ")}.`);
      const row: Row = mcpConnection(crypto.randomUUID(), String(body.name), org, body.scope as "org", userId, {
        url: service.url,
        catalogId: service.id,
        authType: "oauth",
        status: "not_connected",
      });
      state.connections.push(row);
      return json({ connection: connectionDto(row) });
    }
    const invalid = invalidDefinition(body);
    if (invalid) return controlFail(400, "invalid", invalid);
    const row: Row = mcpConnection(crypto.randomUUID(), String(body.name), org, body.scope as "org", userId, {
      ...definitionFields(body),
      // A stdio definition is configured for launch once saved: it starts inside each sandbox, never here.
      status: body.transport === "stdio" ? "connected" : "not_connected",
    });
    state.connections.push(row);
    return json({ connection: connectionDto(row) });
  }
  const row = visibleConnections(org, userId).find((item) => item.id === body.id);
  if (!row) return controlFail(404, "not_found", "That connection does not exist.");
  const writable = row.scope === "personal" ? row.owner === userId : isAdmin(org, userId);
  if (operation === "status") return json({ connection: connectionDto(row) });
  if (!writable) return controlFail(403, "forbidden", "Only an org admin changes org connections.");
  switch (operation) {
    case "update": {
      // The registry's save is a full replace of the definition: the immutable scope must be restated, and
      // every saved authentication is cleared.
      const invalid = invalidDefinition(body);
      if (invalid) return controlFail(400, "invalid", invalid);
      if (body.scope !== row.scope) return controlFail(400, "invalid", "The scope of a connection cannot change.");
      for (const key of ["name", "transport", "url", "command", "args", "authType", "accountLabel", "lastError"]) {
        delete row[key];
      }
      for (const key of ["toolCount", "resourceCount", "promptCount", "authentication"]) delete row[key];
      Object.assign(row, definitionFields(body));
      row.status = row.transport === "stdio" ? "connected" : "not_connected";
      return json({ connection: connectionDto(row) });
    }
    case "connect": {
      if (failConnect) return controlFail(503, "unavailable", "The authorization server did not answer.");
      const authorizationUrl = probe(row);
      const pending = authorizationUrl ? new URL(authorizationUrl).searchParams.get("state") : null;
      const entry = pending ? pendingOAuth.get(pending) : undefined;
      if (entry) entry.user = userId;
      return json({ connection: connectionDto(row), ...(authorizationUrl ? { authorizationUrl } : {}) });
    }
    case "metadata": {
      // Metadata only: the stored authorization, the status and running sandboxes' access are left as they are.
      if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
        return controlFail(400, "invalid", "name must be a non-empty string.");
      }
      if (body.defaultForLaunch !== undefined && typeof body.defaultForLaunch !== "boolean") {
        return controlFail(400, "invalid", "defaultForLaunch must be true or false.");
      }
      if (typeof body.name === "string") row.name = body.name;
      if (typeof body.defaultForLaunch === "boolean") row.defaultForLaunch = body.defaultForLaunch;
      return json({ connection: connectionDto(row) });
    }
    case "set-enabled": {
      if (typeof body.enabled !== "boolean") return controlFail(400, "invalid", "enabled must be true or false.");
      if (body.enabled === false) {
        if (row.status !== "disabled") row.statusBeforeDisable = row.status;
        row.status = "disabled";
      } else if (row.status === "disabled") {
        row.status = row.statusBeforeDisable ?? "not_connected";
        delete row.statusBeforeDisable;
      }
      return json({ connection: connectionDto(row) });
    }
    case "revoke":
      delete row.authentication;
      delete row.accountLabel;
      row.status = "not_connected";
      return json({ ok: true });
    case "delete":
      state.connections = state.connections.filter((item) => item !== row);
      return json({ ok: true });
    default:
      return controlFail(404, "not_found", "Unknown route.");
  }
}

/** The API side of `/auth/mcp/callback`: the pending state names the user and connection; the code must match. */
function oauthCallback(body: Row, userId: string): Response {
  const pending = pendingOAuth.get(String(body.state ?? ""));
  if (!pending || pending.user !== userId || !pending.code || pending.code !== body.code) {
    return controlFail(400, "invalid", "That authorization is not pending.");
  }
  if (body.issuer !== undefined && body.issuer !== ISSUER) return controlFail(400, "invalid", "Unexpected issuer.");
  pendingOAuth.delete(String(body.state));
  const row = state.connections.find((item) => item.id === pending.connection);
  if (!row) return controlFail(404, "not_found", "That connection does not exist.");
  Object.assign(row, {
    status: "connected",
    accountLabel: "service@oauth.test",
    toolCount: 9,
    resourceCount: 2,
    promptCount: 1,
  });
  delete row.lastError;
  return json({ connection: connectionDto(row) });
}

/** The upstream server's consent page; it sends the browser to the dashboard's callback with a one-time code. */
function oauth(url: URL): Response {
  const pendingState = url.searchParams.get("state") ?? "";
  const pending = pendingOAuth.get(pendingState);
  const row = pending ? state.connections.find((item) => item.id === pending.connection) : undefined;
  if (url.pathname === "/oauth/authorize") {
    if (!row) return new Response("unknown state", { status: 400 });
    const page = `<!doctype html><title>Authorize</title><h1>Authorize Armada for ${String(row.name)}</h1>
<a href="/oauth/decide?state=${pendingState}&decision=allow">Allow</a> <a href="/oauth/decide?state=${pendingState}&decision=deny">Deny</a>`;
    return new Response(page, { headers: { "content-type": "text/html" } });
  }
  const back = new URL("/auth/mcp/callback", DASHBOARD);
  back.searchParams.set("state", pendingState);
  if (pending && url.searchParams.get("decision") === "allow") {
    pending.code = `code-${crypto.randomUUID()}`;
    back.searchParams.set("code", pending.code);
    back.searchParams.set("iss", ISSUER);
  } else {
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("error_description", "The user said no <script>");
  }
  return new Response(null, { status: 302, headers: { location: back.toString() } });
}

/**
 * Durable golden build jobs, as `docs/golden-build-jobs.md` describes the server: `golden/create` and
 * `golden/update` check the request at admission and answer 202 with a queued job; the build itself publishes
 * later, here on a status read (`golden/build/status`) once the gate is open. The same requester, org and
 * idempotency key with the same request return the same job; the same key with another request is a 409.
 * Status is read by `{jobId}` or `{org, idempotencyKey}`, by the job's owner only, and carries only the safe
 * fields: jobId, state, phase, errorCode and the public result.
 */
type GoldenJob = {
  id: string;
  route: string;
  body: Row;
  owner: string;
  key: string;
  status: { state: string; phase: string; errorCode: string | null; result: Row | null };
};
const goldenJobs = new Map<string, GoldenJob>();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

function jobJson(job: GoldenJob): Row {
  return { jobId: job.id, ...job.status };
}

async function goldenBuild(route: string, body: Row, request: Request): Promise<Response> {
  const userId = viewer(request);
  state.goldenCalls.push({ route, body, authorized: Boolean(userId) });
  if (!userId) return json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
  // Admission never waits for the build: a held gate keeps the admitted job running until it is released.
  const failure = state.goldenGate.fail;
  // A failure without a code is a gateway's own answer (a timeout in front of the server), not the server's.
  if (failure)
    return failure.code
      ? json({ error: { code: failure.code, message: failure.message } }, failure.status)
      : new Response(failure.message, { status: failure.status, headers: { "content-type": "text/plain" } });
  const key = String(body.idempotencyKey ?? "");
  if (!IDEMPOTENCY_KEY.test(key))
    return json({ error: { code: "invalid", message: "idempotencyKey is required." } }, 400);
  const { idempotencyKey: _key, ...payload } = body;
  const fingerprint = JSON.stringify([route, payload]);
  const existing = [...goldenJobs.values()].find(
    (job) => job.owner === userId && job.body.org === body.org && job.key === key,
  );
  if (existing) {
    const { idempotencyKey: _same, ...before } = existing.body;
    if (JSON.stringify([existing.route, before]) !== fingerprint)
      return json({ error: { code: "conflict", message: "That idempotency key was used for another build." } }, 409);
    return json(jobJson(existing), 202);
  }
  const refused = admitGoldenBuild(route, body, userId);
  if (refused) return refused;
  const job: GoldenJob = {
    id: id(++sequence),
    route,
    body,
    owner: userId,
    key,
    status: { state: "queued", phase: "queued", errorCode: null, result: null },
  };
  goldenJobs.set(job.id, job);
  if (state.goldenGate.loseAnswer)
    return new Response("Gateway Timeout", { status: 504, headers: { "content-type": "text/plain" } });
  return json(jobJson(job), 202);
}

async function goldenJobStatus(body: Row, request: Request): Promise<Response> {
  const userId = viewer(request);
  state.goldenStatusCalls.push(body);
  if (state.goldenGate.failStatus)
    return json({ error: { code: "unavailable", message: "Status is unavailable." } }, 503);
  if (!userId) return json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
  const job =
    body.jobId !== undefined
      ? goldenJobs.get(String(body.jobId))
      : [...goldenJobs.values()].find(
          (item) => item.owner === userId && item.body.org === body.org && item.key === body.idempotencyKey,
        );
  if (!job || job.owner !== userId || !isMember(job.body.org, userId))
    return json({ error: { code: "not_found", message: "No such build." } }, 404);
  if (job.status.state === "queued" || job.status.state === "running") {
    if (state.goldenGate.hold)
      job.status = { state: "running", phase: "checkout_baseline", errorCode: null, result: null };
    else {
      const result = publishGoldenBuild(job.route, job.body, job.owner);
      job.status = result
        ? { state: "succeeded", phase: "complete", errorCode: null, result }
        : { state: "failed", phase: "publish", errorCode: "build_failed", result: null };
    }
  }
  return json(jobJson(job));
}

/** What the server checks at admission: membership, the provider, the owner/admin rule and the rebuild target. */
function admitGoldenBuild(route: string, body: Row, userId: string): Response | null {
  const org = String(body.org);
  if (!isMember(org, userId)) return json({ error: { code: "forbidden", message: "Not a member." } }, 403);
  if (body.provider !== undefined && body.provider !== "boat" && body.provider !== "modal")
    return json({ error: { code: "invalid", message: "Provider is boat or modal." } }, 400);
  const name = String(body.name);
  if (route === "golden/create") {
    // Absent means Boat, as on the server. A provider not configured for the org is refused, never redirected.
    const provider = (body.provider ?? "boat") as "boat" | "modal";
    const unconfigured = state.capabilities[provider].fail;
    if (unconfigured) return json({ error: { code: "provider_not_configured", message: unconfigured.message } }, 503);
    if (!body.private && !isAdmin(org, userId))
      return json({ error: { code: "forbidden", message: "Only an admin can create an org golden." } }, 403);
    if (state.goldens.some((row) => row.org_id === org && row.name === name && row.provider === provider))
      return json({ error: { code: "conflict", message: `Golden '${name}' already exists on ${provider}.` } }, 409);
    return null;
  }
  const target = rebuildTarget(body, userId);
  if (target instanceof Response) return target;
  const allowed = target.visibility === "private" ? target.owner_id === userId : isAdmin(org, userId);
  if (!allowed) return json({ error: { code: "forbidden", message: "You cannot rebuild this golden." } }, 403);
  return null;
}

/** The server's selectGolden: the name, narrowed to the body's provider; still more than one is a conflict. */
function rebuildTarget(body: Row, userId: string): Row | Response {
  const rows = liveGoldens(userId).filter(
    (row) =>
      row.org_id === body.org &&
      row.name === body.name &&
      (body.provider === undefined || row.provider === body.provider),
  );
  if (rows.length > 1)
    return json(
      { error: { code: "conflict", message: "Golden exists on boat and modal. Pass --provider boat or modal." } },
      409,
    );
  return rows[0] ?? json({ error: { code: "not_found", message: "No golden." } }, 404);
}

/** The worker's atomic publication: the new or rebuilt row and its snapshot, on the golden's own provider. */
function publishGoldenBuild(route: string, body: Row, userId: string): Row | null {
  const org = String(body.org);
  const name = String(body.name);
  const config = body.config as Row;
  const snapshot = `golden-${++sequence}`;
  if (route === "golden/create") {
    const provider = (body.provider ?? "boat") as "boat" | "modal";
    const visibility = body.private ? "private" : "org";
    state.goldens.push({
      ...golden(id(++sequence), name, visibility, userId, provider === "boat" ? snapshot : null),
      org_id: org,
      provider,
      provider_snapshot_id: snapshot,
      config,
    });
    return { name, visibility, snapshot };
  }
  const target = rebuildTarget(body, userId);
  if (target instanceof Response) return null;
  target.config = config;
  target.provider_snapshot_id = snapshot;
  if (target.provider === "boat") target.boat_snapshot_id = snapshot;
  return { name, visibility: target.visibility, snapshot };
}

const SIZES = ["small", "medium", "large", "xlarge"];

/**
 * `golden/size-policy {golden, org, provider, policy?}` (#653): reads, or with `policy` replaces, a visible golden's
 * size defaults under the owner (private) or admin (org) rule; directories must be the golden's configured ones.
 */
function goldenSizePolicy(body: Row, request: Request): Response {
  const userId = viewer(request);
  state.sizePolicyCalls.push(body);
  if (state.olderServer) return controlFail(404, "not_found", "Unknown route.");
  if (!userId) return controlFail(401, "unauthorized", "Sign in.");
  const row = liveGoldens(userId).find(
    (item) => item.name === body.golden && item.org_id === body.org && item.provider === (body.provider ?? "boat"),
  );
  if (!row) return controlFail(404, "not_found", "No golden named that.");
  const repositories = ((row.config as { repos?: Row[] }).repos ?? []) as Row[];
  if (body.policy !== undefined) {
    const allowed = row.visibility === "private" ? row.owner_id === userId : isAdmin(row.org_id, userId);
    if (!allowed) return controlFail(403, "forbidden", "You cannot change this golden's size policy.");
    const policy = body.policy as { version?: unknown; golden?: unknown; repositories?: Record<string, unknown> };
    const dirs = repositories.map((repo) => repo.dir);
    if (
      policy.version !== 1 ||
      (policy.golden !== null && !SIZES.includes(String(policy.golden))) ||
      Object.entries(policy.repositories ?? {}).some(
        ([dir, size]) => !dirs.includes(dir) || !SIZES.includes(String(size)),
      )
    )
      return controlFail(400, "invalid_request", "Unsupported size policy.");
    row.size_policy = policy;
  }
  return json({ goldenId: row.id, provider: row.provider, repositories, policy: row.size_policy ?? null });
}

/**
 * `golden/remove {id, org?}` (#566): retires a visible golden by id under the owner/admin rule. The row stays as a
 * tombstone so its sandboxes and their history remain; provider artifacts are retained. Answers
 * `{id, removedAt, artifacts: "retained"}`.
 */
function goldenRemove(body: Row, request: Request): Response {
  const userId = viewer(request);
  state.goldenRemoveCalls.push({ body, authorized: Boolean(userId) });
  if (!userId) return json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
  const row = liveGoldens(userId).find(
    (item) => item.id === body.id && (body.org === undefined || item.org_id === body.org),
  );
  if (!row) return json({ error: { code: "not_found", message: "No golden." } }, 404);
  const allowed = row.visibility === "private" ? row.owner_id === userId : isAdmin(row.org_id, userId);
  if (!allowed)
    return json({ error: { code: "forbidden", message: "Only the owner or an org admin removes this golden." } }, 403);
  row.removed_at = new Date().toISOString();
  return json({ id: row.id, removedAt: row.removed_at, artifacts: "retained" });
}

/** `golden/capabilities {org, provider}`: the server's scoped read of the org's limit on that provider. */
function goldenCapabilities(body: Row, request: Request): Response {
  const userId = viewer(request);
  state.capabilityCalls.push({ body, authorized: Boolean(userId) });
  if (!userId) return json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
  if (!isMember(body.org, userId))
    return json({ error: { code: "forbidden", message: "You are not a member of this org." } }, 403);
  const provider = body.provider ?? "boat";
  if (provider !== "boat" && provider !== "modal")
    return json({ error: { code: "invalid", message: "Provider is boat or modal." } }, 400);
  const entry = state.capabilities[provider];
  const failure = entry.fail;
  if (failure)
    return json(
      failure.code ? { error: { code: failure.code, message: failure.message } } : { error: failure.message },
      failure.status,
    );
  return json(
    {
      provider,
      maxGoldens: entry.maxGoldens,
      ...(entry.bindings === null
        ? {}
        : {
            bindings:
              entry.bindings ??
              state.goldens
                .filter(
                  (g) =>
                    g.org_id === body.org &&
                    g.provider === provider &&
                    (g.visibility === "org" || g.owner_id === userId),
                )
                .map((g) => ({ goldenId: g.id, relation: "current_backend" })),
          }),
    },
    200,
    { "cache-control": "no-store" },
  );
}

/**
 * The API's public `POST /api/v1/github/oauth/callback {state, code}` for the CLI's GitHub sign-in. The flow state is
 * the API's own one-use record (the actor is bound there), so the request carries no cookie and no bearer. Unknown,
 * used, cancelled or mismatched flows are refused with the API's error shape; success is fixed metadata.
 */
const githubCliFlows = new Map<string, { code: string; status: "pending" | "used" | "canceled" }>();

function githubCliCallback(request: Request, body: Row): Response {
  state.githubCliCalls.push({
    body,
    authorization: request.headers.get("authorization"),
    cookie: request.headers.get("cookie"),
  });
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "code,state") return controlFail(400, "invalid", "The body is {state, code}.");
  const flow = githubCliFlows.get(String(body.state));
  if (flow?.status !== "pending") return controlFail(400, "invalid", "That sign-in is not pending.");
  if (flow.code !== body.code) return controlFail(400, "invalid", "That sign-in is not pending.");
  flow.status = "used";
  return json({ ok: true, provider: "github" });
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

function orgCredential(cid: string, owner: string, kind: string): Row {
  return { id: cid, scope: "org", owner_id: owner, kind, value_enc: "\\x0102", created_at: "2026-11-08T10:00:00.000Z" };
}

/**
 * `org/provider/status`, `org/provider/connect` and `org/provider/disconnect`, as the Armada API serves them. Readiness is derived from the
 * stored state only: the org's Boat column or an org-scoped Modal credential. A personal key never counts. Connect is
 * admin-only, checks the value with the provider (here: a value containing "rejected" is refused) and stores
 * ciphertext, never the value, so a refused replacement keeps the stored one. Disconnect is admin-only and clears that
 * provider alone. Each answers the same status.
 */
function orgProvider(route: string, body: Row, request: Request): Response {
  const userId = viewer(request);
  state.providerCalls.push({ route, body, authorized: Boolean(userId) });
  if (!userId) return controlFail(401, "unauthorized", "Sign in.");
  const org = state.orgs.find((row) => row.id === body.org);
  if (!org || !isMember(org.id, userId)) return controlFail(403, "forbidden", "You are not a member of this org.");
  if (route === "org/provider/status" && state.providerStatusFail) {
    const failure = state.providerStatusFail;
    if (failure.html !== undefined)
      return new Response(failure.html, { status: failure.status, headers: { "content-type": "text/html" } });
    return json(
      failure.code ? { error: { code: failure.code, message: failure.message } } : { error: failure.message },
      failure.status,
    );
  }
  if (route === "org/provider/connect") {
    if (!isAdmin(org.id, userId))
      return controlFail(403, "forbidden", "Only an org admin connects a sandbox provider.");
    const provider = body.provider;
    if (provider !== "boat" && provider !== "modal") return controlFail(400, "invalid", "Provider is boat or modal.");
    const value = typeof body.value === "string" ? body.value : "";
    if (!value) return controlFail(400, "invalid", "A credential value is required.");
    if (provider === "modal") {
      let pair: unknown;
      try {
        pair = JSON.parse(value);
      } catch {
        pair = null;
      }
      const keys = pair && typeof pair === "object" ? Object.keys(pair).sort().join(",") : "";
      if (keys !== "token_id,token_secret")
        return controlFail(400, "invalid", "A Modal token is {token_id, token_secret}.");
    }
    if (value.includes("rejected"))
      return controlFail(
        400,
        "provider_rejected",
        `${provider === "boat" ? "Boat" : "Modal"} refused these credentials.`,
      );
    const existing = state.credentials.find(
      (row) => row.scope === "org" && row.owner_id === org.id && row.kind === provider,
    );
    if (provider === "boat") org.boat_api_key_enc = "\\x0304";
    else if (existing) existing.value_enc = "\\x0304";
    else state.credentials.push(orgCredential(id(++sequence), String(org.id), provider));
  }
  if (route === "org/provider/disconnect") {
    if (!isAdmin(org.id, userId)) return controlFail(403, "forbidden", "Only an org admin can do that.");
    const provider = body.provider;
    if (provider !== "boat" && provider !== "modal") return controlFail(400, "invalid", "Provider is boat or modal.");
    if (provider === "boat") org.boat_api_key_enc = null;
    else
      state.credentials = state.credentials.filter(
        (row) => !(row.scope === "org" && row.owner_id === org.id && row.kind === provider),
      );
  }
  const configured = (provider: string) =>
    provider === "boat"
      ? Boolean(org.boat_api_key_enc)
      : state.credentials.some((row) => row.scope === "org" && row.owner_id === org.id && row.kind === provider);
  const providers = ["boat", "modal"].map((provider) => ({ provider, configured: configured(provider) }));
  const role = isAdmin(org.id, userId) ? "admin" : "member";
  return json(
    { org: { id: org.id, name: org.name, role }, ready: providers.some((item) => item.configured), providers },
    200,
    { "cache-control": "no-store" },
  );
}

function control(url: URL, body: Row): Response {
  if (url.pathname === "/__test/reset") {
    state = seed();
    orchestratorTestControl("reset", {});
    pendingOAuth.clear();
    githubCliFlows.clear();
    failSandboxConnections = false;
    failCatalog = false;
    failConnect = false;
    if (body.multiOrg) {
      const now = "2026-11-08T10:00:00.000Z";
      state.orgs.push({ id: id(11), name: "Zenith", created_at: now, boat_api_key_enc: "\\x0102" });
      state.members.push({ org_id: id(11), user_id: ALICE, role: "member", created_at: now });
      state.goldens.push({ ...golden(id(23), "zenith-golden", "org", ALICE, "snap-zenith"), org_id: id(11) });
      state.sandboxes.push({ ...sandbox(id(33), "bx_zenith", id(23), ALICE, "codex", "ready", now), org_id: id(11) });
      state.connections.push(
        mcpConnection(id(64), "Zenith Search", id(11), "org", ALICE, {
          url: "https://search.zenith.test/mcp",
          authType: "none",
          status: "connected",
        }),
      );
    }
    if (body.sizePolicies) {
      // The server has #653's column: every golden reads `size_policy`; the Boat org golden has defaults.
      for (const row of state.goldens) row.size_policy = null;
      const shared = state.goldens.find((row) => row.name === "shared-golden" && row.provider === "boat");
      if (shared) shared.size_policy = { version: 1, golden: "medium", repositories: { api: "large" } };
      state.refuseSize = typeof body.refuseSize === "string" ? body.refuseSize : null;
      state.olderServer = body.olderServer === true;
    }
    if (body.modalTwin) {
      // A Modal golden with the same name as the Boat `shared-golden`, recording another repository.
      state.goldens.push({
        ...golden(id(24), "shared-golden", "org", ALICE, null),
        provider: "modal",
        provider_snapshot_id: "modal-snap-1",
        config: {
          repos: [{ url: "https://github.com/acme/docs.git", branch: "main", dir: "docs" }],
          init: [],
        },
        ...(body.sizePolicies ? { size_policy: null } : {}),
      });
    }
    if (body.novaOrg) {
      // An org with no golden yet, administered by carol, with its own Boat key.
      state.orgs.push({
        id: id(12),
        name: "Nova",
        created_at: "2026-11-08T10:00:00.000Z",
        boat_api_key_enc: "\\x0102",
      });
      state.members.push({ org_id: id(12), user_id: id(3), role: "admin", created_at: "2026-11-08T10:00:00.000Z" });
    }
    // Modal connected for the organization as well (#598): new work may then choose it.
    if (body.acmeModal) state.credentials.push(orgCredential(id(45), ACME, "modal"));
    if (body.novaModal) state.credentials.push(orgCredential(id(46), id(12), "modal"));
    if (body.orionOrg) {
      // An org that never finished its provider setup (#576): carol is its admin, bob a member, nothing configured.
      const now = "2026-11-08T10:00:00.000Z";
      state.orgs.push({ id: ORION, name: "Orion", created_at: now });
      state.members.push({ org_id: ORION, user_id: id(3), role: "admin", created_at: now });
      state.members.push({ org_id: ORION, user_id: BOB, role: "member", created_at: now });
      // Carol's personal Boat key: it must never make Orion ready.
      state.credentials.push({ ...orgCredential(id(43), id(3), "boat"), scope: "user" });
      if (body.orionModal) state.credentials.push(orgCredential(id(44), ORION, "modal"));
      if (body.orionSandbox) {
        state.goldens.push({ ...golden(id(25), "orion-golden", "org", id(3), "snap-orion"), org_id: ORION });
        state.sandboxes.push({
          ...sandbox(id(34), "bx_orion_running", id(25), id(3), "claude", "running", now),
          org_id: ORION,
        });
      }
    }
    sessions.clear();
    goldenJobs.clear();
    return json({ ok: true });
  }
  if (url.pathname === "/__test/clear-legacy-boat") {
    // An operator cleared the org's legacy Boat column (the key was revoked): the org is no longer ready.
    for (const org of state.orgs) if (org.id === body.org) org.boat_api_key_enc = null;
    return json({ ok: true });
  }
  if (url.pathname === "/__test/provider-status-fail") {
    state.providerStatusFail = body.fail ? (body.fail as State["providerStatusFail"]) : null;
    return json({ ok: true });
  }
  if (url.pathname === "/__test/golden-gate") {
    state.goldenGate = {
      loseAnswer: body.loseAnswer === true,
      failStatus: body.failStatus === true,
      hold: body.hold === true,
      fail: body.fail ? (body.fail as State["providerStatusFail"]) : null,
    };
    return json({ ok: true });
  }
  if (url.pathname === "/__test/capabilities") {
    const provider = body.provider === "modal" ? "modal" : "boat";
    state.capabilities[provider] = {
      bindings: body.bindings as Row[] | null | undefined,
      maxGoldens: body.maxGoldens === null ? null : Number(body.maxGoldens ?? 1),
      fail: body.fail ? (body.fail as State["providerStatusFail"]) : null,
    };
    return json({ ok: true });
  }
  if (url.pathname === "/__test/golden-release") {
    state.goldenGate.hold = false;
    return json({ ok: true });
  }
  if (url.pathname === "/__test/goldens") {
    return json(state.goldens.map((row) => ({ ...row })));
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
  if (url.pathname === "/__test/github-cli-flow") {
    // Only the shape the API issues: `armada_cli_` and 72 lowercase hex or hyphen characters.
    if (!/^armada_cli_[0-9a-f-]{72}$/.test(String(body.state))) return json({ message: "unrealistic state" }, 400);
    githubCliFlows.set(String(body.state), {
      code: String(body.code),
      status: body.canceled ? "canceled" : "pending",
    });
    return json({ ok: true });
  }
  if (url.pathname === "/__test/sandbox-lifecycle") {
    // The additive #565 fields on one sandbox row, as the database would hold them; the status is left alone.
    const row = state.sandboxes.find((item) => item.id === body.id);
    if (!row) return json({ message: "no sandbox" }, 404);
    Object.assign(row, body.fields as Row);
    return json({ ok: true });
  }
  if (url.pathname === "/__test/fail-connect") {
    failConnect = true;
    return json({ ok: true });
  }
  if (url.pathname === "/__test/fail-catalog") {
    failCatalog = true;
    return json({ ok: true });
  }
  if (url.pathname === "/__test/sandbox-events") {
    state.events.set(String(body.sandbox), (body.events as Row[]) ?? []);
    return json({ ok: true });
  }
  if (url.pathname === "/__test/fail-next-tool") {
    state.failNextTool = String(body.message);
    return json({ ok: true });
  }
  if (url.pathname === "/__test/fail-sandbox-connections") {
    failSandboxConnections = true;
    return json({ ok: true });
  }
  /**
   * What GoTrue's `/verify` hands the browser for #649's email OTP (sent without a PKCE challenge): a live session for
   * the address, which the redirect puts in the URL fragment. The tests build the incoming URL from it to prove the
   * dashboard never uses it. No email is sent.
   */
  if (url.pathname === "/__test/email-link-session") {
    const user = [...users.values()].find((candidate) => candidate.email === body.email);
    return user ? json(session(user.id)) : json({ error: "unknown user" }, 404);
  }
  if (url.pathname === "/__test/unverified-email") {
    state.unverifiedEmails.push(String(body.email));
    return json({ ok: true });
  }
  /** Marks an invitation as the server would after a revoke or an acceptance elsewhere. */
  if (url.pathname === "/__test/invitation-status") {
    const row = state.invitations.find((item) => item.token === body.token);
    if (row) row.status = body.status;
    return json({ ok: true });
  }
  if (url.pathname === "/__test/invitation-delivery") {
    state.nextDelivery = body.delivery as State["nextDelivery"];
    return json({ ok: true });
  }
  /** The link an invitation email would carry right now: the current token of that address's pending invitation. */
  if (url.pathname === "/__test/invitation-link") {
    const row = state.invitations.find((item) => item.email === body.email && item.status === "pending");
    return json({ token: row?.token ?? null });
  }
  /** A pending invitation as the server would hold it, for the recipient pages (expired ones included). */
  if (url.pathname === "/__test/seed-invitation") {
    const row: Row = {
      id: id(++sequence),
      orgId: ACME,
      email: body.email,
      role: body.role ?? "member",
      expiresAt: new Date(Date.now() + Number(body.expiresInMs ?? 7 * 86_400_000)).toISOString(),
      status: "pending",
      delivery: "sent",
      token: body.token,
    };
    state.invitations.push(row);
    return json({ ok: true });
  }
  if (url.pathname === "/__test/state") {
    return json({
      orgBoatKeys: state.orgs.filter((org) => org.boat_api_key_enc).map((org) => org.id),
      otpEmails: state.otpEmails,
      sent: state.sent,
      toolCalls: state.toolCalls,
      launches: state.launches,
      goldenCalls: state.goldenCalls,
      goldenStatusCalls: state.goldenStatusCalls,
      goldenRemoveCalls: state.goldenRemoveCalls,
      sizePolicyCalls: state.sizePolicyCalls,
      sizedRefusals: state.sizedRefusals,
      launchRoutes: state.launchRoutes,
      capabilityCalls: state.capabilityCalls,
      githubCliCalls: state.githubCliCalls,
      controlCalls: state.controlCalls,
      providerCalls: state.providerCalls,
      invitationCalls: state.invitationCalls,
      authCalls: state.authCalls,
      invitations: state.invitations.map(invitationDto),
      members: state.members,
      connections: state.connections.map((row) => ({ ...row })),
    });
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
    if (url.pathname.startsWith("/__test/orchestrators/"))
      return orchestratorTestControl(url.pathname.slice("/__test/orchestrators/".length), body);
    if (url.pathname.startsWith("/__test/")) return control(url, body);
    if (url.pathname === "/api/v1/orchestrators" || url.pathname.startsWith("/api/v1/orchestrators/"))
      return orchestratorRoute(request, url, body, viewer(request));
    if (url.pathname === "/api/v1/creds/list" && request.method === "POST") return credsList(viewer(request));
    if (url.pathname === "/mcp") return mcp(body as unknown as RpcMessage, viewer(request));
    if (url.pathname === "/api/v1/sandbox/launch" && request.method === "POST")
      return launchRoute(body, viewer(request));
    if (url.pathname === "/api/v1/sandbox/launch-sized-v1" && request.method === "POST") {
      // #653's fail-closed route (ea501bd): an older replica does not know it, a newer one checks the version first.
      // Either refusal comes before anything is allocated.
      state.sizedRefusals.push(body);
      if (state.olderServer) return controlFail(404, "not_found", "Unknown route.");
      if (body.sizePolicyVersion !== 1)
        return controlFail(400, "invalid", "The sized launch route requires sizePolicyVersion 1.");
      state.sizedRefusals.pop();
      return launchRoute(body, viewer(request), "sandbox/launch-sized-v1");
    }
    if (url.pathname === "/api/v1/github/oauth/callback" && request.method === "POST") {
      return githubCliCallback(request, body);
    }
    if (url.pathname.startsWith("/api/v1/mcp/") && request.method === "POST") {
      return mcpControl(url.pathname.slice("/api/v1/mcp/".length), body, viewer(request));
    }
    if (url.pathname.startsWith("/oauth/")) return oauth(url);
    if (url.pathname.startsWith("/api/v1/")) {
      const route = url.pathname.slice("/api/v1/".length);
      if (route === "auth/email/start") return json({ ok: true });
      if (route === "golden/build/status") return goldenJobStatus(body, request);
      if (route === "golden/create" || route === "golden/update") return goldenBuild(route, body, request);
      if (route === "golden/capabilities") return goldenCapabilities(body, request);
      if (route === "golden/remove") return goldenRemove(body, request);
      if (route === "golden/size-policy") return goldenSizePolicy(body, request);
      if (route === "org/provider/status" || route === "org/provider/connect" || route === "org/provider/disconnect")
        return orgProvider(route, body, request);
      if (route.startsWith("org/invitations/"))
        return invitations(route.slice("org/invitations/".length), body, request);
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

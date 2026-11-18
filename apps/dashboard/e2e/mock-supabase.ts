import {
  accountBindingAvailability,
  type Harness,
  harnessesForCredential,
  harnessForCredential,
  type MachineSizePolicy,
  MODEL_CREDENTIAL_KINDS,
  parseDockerSnapshotRecord,
  ROUTINE_REASON_HELP,
  resolveMachineSize,
} from "@armada/core";
import { largeSandboxExpiry } from "./fixture-expiry";

/**
 * A stand-in for Supabase Auth, PostgREST and the Armada MCP server, for the browser tests.
 * It models what the dashboard relies on: sessions by bearer token, the row level security
 * rules of supabase/migrations (private goldens, org-only keys, admin-only writes), the
 * column grant that keeps ciphertext unreadable, the `logs` / `stop` / `send` / `launch` tools, the MCP
 * connection control API with its write-only authentication, and an upstream OAuth consent page.
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
const LARGE = id(14);
const LARGE_HOST = id(9000);
// Conservative 8 KiB request-target budget (Kong/Nginx buffer default); not a verified hosted gateway setting.
// Measure encoded bytes, so large in() filters cannot silently pass the fixture.
const MAX_REQUEST_TARGET_BYTES = 8192;

const users = new Map<string, { id: string; email: string }>([
  [ALICE, { id: ALICE, email: "alice@example.com" }],
  [BOB, { id: BOB, email: "bob@example.com" }],
  [id(3), { id: id(3), email: "carol@example.com" }],
]);

type State = {
  orgs: Row[];
  langfuse: Map<string, Row>;
  members: Row[];
  goldens: Row[];
  sandboxes: Row[];
  credentials: Row[];
  github_connections: Row[];
  githubInstallations: Row[];
  events: Map<string, Row[]>;
  /** Every launch body that reached allocation, as the dashboard sent it. */
  launches: Row[];
  /** Per-provider snapshot capacity returned by the mock. */
  capabilities: Record<
    "boat" | "modal",
    {
      maxGoldens: number | null;
    }
  >;
  /** The registry's connections. `authentication` is the write-only value; no response ever includes it. */
  connections: Row[];
  agentDefaults: Record<string, Row[]>;
  /** Organization invitations (#640 contract v1). `token` is what the email link carries; no response includes it. */
  invitations: Row[];
  /**
   * #921's application vault: readable variables (`value`) and write-only secrets (`sealed`, which no response ever
   * includes; a deleted or revoked item has none).
   */
  vault: Row[];
  /**
   * #938's launch templates: headers (`deleted` tombstones kept), their immutable revisions
   * and the launch requests by key.
   */
  templates: Row[];
  templateRevisions: Row[];
  templateRequests: Map<string, Row>;
  routines: Row[];
  routineHistory: Row[];
};

function seed(): State {
  const now = "2026-11-08T10:00:00.000Z";
  const state: State = {
    langfuse: new Map(),
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
      {
        ...sandbox(id(30), "bx_alice_running", id(20), ALICE, "claude", "running", "2026-11-08T10:05:00.000Z"),
        // Reported usage (#770): two Claude turns and a completed compute interval, priced by the dashboard (#875).
        usage_runtime_seconds: 754,
        usage_running_since: null,
        usage_turns: {
          turnCount: 2,
          turns: [
            {
              promptId: "p-1",
              model: "claude-opus-5-5",
              inputTokens: 12000,
              outputTokens: 9500,
              cachedTokens: 480000,
              cacheWriteTokens: 100000,
            },
            {
              promptId: "p-2",
              model: "claude-opus-5-5",
              inputTokens: 3000,
              outputTokens: 4200,
              cachedTokens: 610000,
              cacheWriteTokens: 0,
            },
          ],
        },
      },
      // On Modal, as its golden: the list names the provider from this column, never from the ID (#645).
      {
        ...sandbox(id(31), "bx_alice_failed", id(26), ALICE, "codex", "failed", "2026-11-08T10:04:00.000Z"),
        provider: "modal",
        boat_id: null,
        // The effective size is listed; the evidence behind it (the repository, the capacity) is not (#680).
        machine_size: {
          version: 1,
          requested: null,
          effective: "large",
          source: "repository",
          repositoryDir: "api",
          capacity: null,
        },
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
        // #603 migrates every model row to a named account; its kind's label is its first name.
        name: "Anthropic API key",
        is_default: false,
        version: 1,
        status: "active",
        expires_at: null,
        updated_at: now,
      },
    ],
    github_connections: [],
    vault: [
      vaultItem(id(80), "variable", "org", ALICE, "APP_REGION", { value: "eu-west-1", version: 3 }),
      vaultItem(id(81), "secret", "org", ALICE, "STRIPE_API_KEY", { sealed: "sk_e2e_seeded_org_secret" }),
      vaultItem(id(82), "secret", "personal", ALICE, "ALICE_DEPLOY_TOKEN", { sealed: "e2e_seeded_alice_secret" }),
      vaultItem(id(83), "secret", "personal", ALICE, "OLD_WEBHOOK_SECRET", { status: "revoked", version: 2 }),
      vaultItem(id(84), "variable", "personal", BOB, "BOB_NOTES_URL", { value: "https://notes.bob.test" }),
    ],
    templates: [
      templateRow(id(90), "org", ALICE, "Backend with docs", 2),
      templateRow(id(91), "personal", ALICE, "Modal quick fix", 1),
      templateRow(id(92), "personal", BOB, "Bob scratch", 1),
    ],
    templateRevisions: [
      templateRevision(id(90), 1, { goldenId: id(20), provider: "boat", harness: "claude", connections: [] }),
      templateRevision(id(90), 2, {
        goldenId: id(20),
        provider: "boat",
        harness: "claude",
        connections: [id(60)],
        variables: [{ key: "APP_REGION", variableId: id(80), version: 3 }],
      }),
      // Bound to an older version of APP_REGION: the page says a new revision is needed.
      templateRevision(id(91), 1, {
        goldenId: id(26),
        provider: "modal",
        harness: "codex",
        // Bound under another key than the variable's name (set over the API).
        variables: [
          { key: "DEPLOY_REGION", variableId: id(80), version: 2 },
          { key: "FALLBACK_REGION", variableId: id(80), version: 2 },
        ],
        // Pinned over the API at a version the account has since left.
        modelAccount: { id: id(40), version: 9 },
      }),
      templateRevision(id(92), 1, { goldenId: id(22), provider: "boat", harness: "claude" }),
    ],
    templateRequests: new Map(),
    routines: [
      routineRow(id(2200), "org", ALICE, "Morning review", "enabled", id(90), 2),
      routineRow(id(2201), "personal", ALICE, "Release notes", "paused", id(91), 1),
      routineRow(id(2202), "personal", BOB, "Bob private check", "paused", id(90), 2),
    ],
    routineHistory: [
      {
        id: id(2210),
        routineId: id(2200),
        scheduledDueAt: now,
        configurationVersion: 2,
        state: "succeeded",
        reason: null,
        reasonHelp: null,
        taskState: "finished",
        taskHelp: null,
        sandboxId: id(30),
        templateRequestId: id(2220),
        missedIntervals: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: id(2211),
        routineId: id(2200),
        scheduledDueAt: "2026-11-07T10:00:00.000Z",
        configurationVersion: 2,
        state: "skipped",
        reason: "previous_run_alive",
        reasonHelp: ROUTINE_REASON_HELP.previous_run_alive,
        launchRefusal: null,
        taskState: null,
        taskHelp: null,
        sandboxId: null,
        templateRequestId: null,
        missedIntervals: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: id(2212),
        routineId: id(2200),
        scheduledDueAt: "2026-11-06T10:00:00.000Z",
        configurationVersion: 1,
        state: "failed",
        reason: "launch_failed",
        reasonHelp: ROUTINE_REASON_HELP.launch_failed,
        taskState: null,
        taskHelp: null,
        sandboxId: null,
        templateRequestId: id(2221),
        missedIntervals: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
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
    launches: [],
    agentDefaults: {},
    // A Boat account holds one golden; Modal is unbounded.
    capabilities: { boat: { maxGoldens: 1 }, modal: { maxGoldens: null } },
    invitations: [],
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
  seedLarge(state);
  return state;
}

/** Fixed arithmetic and fixed timestamps keep every reset and dev boot reproducible. */
function seedLarge(target: State): void {
  const now = "2026-11-16T10:00:00.000Z";
  target.orgs.push({ id: LARGE, name: "Large", created_at: now, boat_api_key_enc: "\\x0102" });
  const owners = [ALICE, BOB, ...Array.from({ length: 6 }, (_, i) => id(9100 + i))];
  owners.forEach((owner, i) => {
    if (!users.has(owner)) users.set(owner, { id: owner, email: `large_member_${i}@example.com` });
    // Alice is deliberately a member: other owners’ interiors must remain unreadable.
    target.members.push({ org_id: LARGE, user_id: owner, role: i === 1 ? "admin" : "member", created_at: now });
  });
  const name = (kind: string, i: number) =>
    i % 4 === 0
      ? `${kind}-${i}-international-platform-observability-and-release-engineering-with-a-very-long-unbroken-suffix`
      : `${kind}-${String(i).padStart(3, "0")}`;
  for (let i = 0; i < 36; i++) {
    const provider = i % 3 === 0 ? "modal" : "boat";
    const snapshot = i % 5 === 0 ? null : `large_snapshot_${i}`;
    target.goldens.push({
      ...golden(id(10000 + i), name("snapshot", i), i % 7 === 0 ? "private" : "org", owners[i % 8]!, snapshot),
      org_id: LARGE,
      provider,
      boat_snapshot_id: provider === "boat" ? snapshot : null,
      config: largeGoldenConfig(),
    });
  }
  for (let i = 0; i < 600; i++) {
    const variant = i % 10;
    const provider = ["boat", "modal", "docker"][i % 3]!;
    const sid = id(11000 + i);
    const status = [
      "starting",
      "running",
      "ready",
      "ready",
      "stopped",
      "stopped",
      "failed",
      "ready",
      "running",
      "stopping",
    ][variant]!;
    target.sandboxes.push({
      ...sandbox(
        sid,
        name("sandbox", i),
        id(10000 + (i % 36)),
        owners[Math.floor(i / 10) % 8]!,
        ["claude", "codex", "opencode"][i % 3]!,
        status,
        new Date(Date.parse(now) - i * 60000).toISOString(),
      ),
      org_id: LARGE,
      provider,
      docker_host_id: provider === "docker" ? LARGE_HOST : null,
      status_reason: variant === 4 ? "idle_paused" : null,
      stopped_at: [4, 5, 6].includes(variant) ? now : null,
      expires_at: largeSandboxExpiry(variant, Date.now()),
      conversation_ids: [`large_conversation_${i}`],
      task_prompt_id: variant === 3 ? `large_prompt_${i}` : null,
      task_outcome:
        variant === 3
          ? i % 20 === 3
            ? { state: "ready", prNumber: 100 + i, prUrl: `https://github.com/example/fixture/pull/${100 + i}` }
            : { state: "blocked", reason: "The fixture needs an owner decision about the integration contract." }
          : null,
      pull_requests:
        variant === 3 && i % 20 === 3
          ? [
              {
                repository: "example/fixture",
                number: 100 + i,
                url: `https://github.com/example/fixture/pull/${100 + i}`,
                headBranch: `fixture-${i}`,
                state: "open",
                checkedAt: now,
              },
            ]
          : [],
      visibility: i % 5 === 0 ? "private" : "org",
      credential_id: id(12000 + (i % 12)),
      credential_version: 1,
      runtime_transport: "dialout",
    });
    target.events.set(sid, [
      {
        id: `large_prompt_${i}`,
        promptId: `large_prompt_${i}`,
        conversationId: `large_conversation_${i}`,
        at: Date.parse(now),
        kind: "prompt",
        text: name("Review", i),
        status: [
          "queued",
          "running",
          "finished",
          "finished",
          "finished",
          "finished",
          "failed",
          "queued",
          "running",
          "running",
        ][variant],
        ...(variant === 6 ? { reason: "usage_limit" } : {}),
      },
    ]);
    if (variant === 2) target.events.set(sid, []);
  }
  for (let i = 0; i < 12; i++)
    target.credentials.push({
      id: id(12000 + i),
      scope: "org",
      owner_id: LARGE,
      kind: MODEL_CREDENTIAL_KINDS[i % MODEL_CREDENTIAL_KINDS.length],
      name: name("model-account", i),
      value_enc: "\\x0102",
      created_at: now,
      updated_at: now,
      status: "active",
      is_default: i === 0,
      version: 1,
      expires_at: i === 1 ? "2026-01-01T00:00:00.000Z" : null,
      ...(i === 0 ? { rateLimited: true, runningAgents: 4, maxAgents: 4 } : {}),
    });
  for (let i = 0; i < 25; i++) {
    const tid = id(13000 + i);
    target.templates.push({
      ...templateRow(tid, i % 5 === 0 ? "personal" : "org", owners[i % 8]!, name("template", i), 1),
      orgId: LARGE,
    });
    target.templateRevisions.push({
      id: id(14000 + i),
      templateId: tid,
      revision: 1,
      definition: {
        goldenId: id(10000 + (i % 36)),
        provider: i % 3 === 0 ? "modal" : "boat",
        harness: "claude",
        model: "claude-opus-5-5",
        reasoningEffort: "high",
        connections: [],
        variables: [],
        skills: [],
      },
    });
  }
  for (let i = 0; i < 15; i++) {
    const rid = id(15000 + i);
    target.routines.push({
      ...routineRow(
        rid,
        "org",
        owners[i % 8]!,
        name("routine", i),
        i % 3 === 0 ? "paused" : "enabled",
        id(13000 + i),
        1,
      ),
      orgId: LARGE,
      nextDueAt: i % 3 === 0 ? null : "2026-11-17T10:00:00.000Z",
    });
    for (let run = 0; run < 3; run++)
      target.routineHistory.push({
        ...target.routineHistory[run],
        id: id(16000 + i * 3 + run),
        routineId: rid,
        sandboxId: run === 0 ? id(11000 + i) : null,
      });
  }
  for (let i = 0; i < 20; i++) {
    target.connections.push(
      mcpConnection(id(17000 + i), name("tool", i), LARGE, i % 5 === 0 ? "personal" : "org", owners[i % 8]!, {
        url: `https://tool-${i}.example.test/mcp`,
        authType: "none",
        status: ["connected", "not_connected", "unavailable", "needs_reconnect"][i % 4],
        toolCount: i + 1,
        resourceCount: 2,
        promptCount: 1,
      }),
    );
    target.vault.push({
      ...vaultItem(
        id(18000 + i),
        i % 2 === 0 ? "variable" : "secret",
        "org",
        owners[i % 8]!,
        `LARGE_CONFIGURATION_${i}`,
        i % 2 === 0 ? { value: `large_fixture_value_${i}` } : { sealed: "large_fixture_secret" },
      ),
      org_id: LARGE,
    });
  }
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

/** These hosts belong only to Large; an explicit test override still takes precedence. */
function largeHosts(): Row[] {
  return [0, 1].map((i) => ({
    id: id(9000 + i),
    name:
      i === 0
        ? "Large platform engineering workstation — release builds and integration workloads"
        : "Offline spare workstation",
    state: i === 0 ? "online" : "offline",
    createdAt: "2026-11-16T10:00:00.000Z",
    lastSeenAt: "2026-11-16T10:00:00.000Z",
    revokedAt: null,
    sandboxes: i === 0 ? 200 : 0,
    version: null,
  }));
}

function largeGoldenConfig() {
  return { repos: [{ url: "https://github.com/example/fixture.git", branch: "main", dir: "fixture" }], init: [] };
}

function largeHostSnapshots(): Row[] {
  return ["ready", "building", "failed", "ready"]
    .map((status, i) => ({
      id: id(19000 + i),
      orgId: LARGE,
      ownerId: ALICE,
      name: `host-snapshot-${i}-platform-integration-environment`,
      provider: "docker",
      visibility: "org",
      hostId: id(9000 + (i === 3 ? 1 : 0)),
      installationId: id(9200 + i),
      hostName: i === 3 ? "Offline spare workstation" : "Large platform engineering workstation",
      hostAvailable: i !== 3,
      definitionHash: "a".repeat(64),
      status,
      image: status === "ready" ? `sha256:${"b".repeat(64)}` : null,
      builtOnVersion: "2.46.4",
      failureReason: status === "failed" ? "Fixture build failed: repository checkout unavailable." : null,
      config: largeGoldenConfig(),
      createdAt: "2026-11-16T10:00:00.000Z",
    }))
    .map((row) => ({ ...parseDockerSnapshotRecord(row) }));
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
      // As in the #680 contract: the raw row is the interior, read only by its owner or a current admin. Legacy
      // visibility and the source golden take no part.
      return state.sandboxes.filter((row) => canOpenSandbox(row, userId));
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

function canOpenSandbox(row: Row, userId: string): boolean {
  return isMember(row.org_id, userId) && (row.owner_id === userId || isAdmin(row.org_id, userId));
}

/**
 * `public.sandbox_list_metadata()` of the #680 contract: every sandbox of the caller's current organizations, as the
 * exact `SandboxListMetadata` allowlist, whoever owns it and whatever its legacy visibility or golden.
 */
function sandboxListMetadata(userId: string): Row[] {
  // As PostgREST serializes timestamptz.
  const at = (value: unknown) =>
    typeof value === "string" ? new Date(value).toISOString().replace(/\.\d{3}Z$/, "+00:00") : null;
  return state.sandboxes
    .filter((row) => isMember(row.org_id, userId))
    .map((row) => {
      const open = canOpenSandbox(row, userId);
      const effective = (row.machine_size as { effective?: unknown } | null | undefined)?.effective;
      const size = ["small", "medium", "large", "xlarge"].includes(String(effective)) ? effective : null;
      return {
        providerSandboxId: row.provider_sandbox_id || null,
        boatId: row.provider === "boat" ? row.provider_sandbox_id || null : null,
        id: row.id,
        orgId: row.org_id,
        ownerId: row.owner_id,
        provider: row.provider,
        harness: row.harness,
        model: row.model ?? null,
        reasoningEffort: row.reasoning_effort ?? null,
        status: row.status,
        idlePaused: row.status === "stopped" && row.status_reason === "idle_paused",
        createdAt: at(row.created_at),
        stoppedAt: at(row.stopped_at),
        expiresAt: at(row.expires_at),
        effectiveTtlSeconds: row.effective_ttl_seconds ?? null,
        machineSize: size,
        // As in the #745/#747 migrations: the outcome is interior (owner and admins), the receipt is metadata.
        taskOutcome: open ? (row.task_outcome ?? null) : null,
        pullRequests: open ? (row.pull_requests ?? []) : null,
        preservationNote: row.preservation_note ?? null,
        displayLabel: `Sandbox ${row.id}`,
        canOpen: open,
        canManage: open,
      };
    });
}

/** PostgREST's filters, first order key, range and exact count over rows a function returned. */
function page(all: Row[], url: URL): Response {
  let rows = all.filter((row) => matches(row, url.searchParams));
  const [column = "", direction = "asc"] = (url.searchParams.get("order") ?? "").split(",")[0]?.split(".") ?? [];
  if (column)
    rows = [...rows].sort(
      (a, b) => String(a[column]).localeCompare(String(b[column])) * (direction === "desc" ? -1 : 1),
    );
  const total = rows.length;
  const offset = Number(url.searchParams.get("offset") ?? 0);
  // As PostgREST: an offset past the rows is not satisfiable.
  if (offset > 0 && offset >= total)
    return json({ code: "PGRST103", message: "Requested range not satisfiable", details: null, hint: null }, 416, {
      "content-range": `*/${total}`,
    });
  const limit = url.searchParams.get("limit");
  rows = rows.slice(offset, limit ? offset + Number(limit) : undefined);
  const range = rows.length ? `${offset}-${offset + rows.length - 1}/${total}` : `*/${total}`;
  return json(rows, 200, { "content-range": range });
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
    if (op === "in" && !inValues(operand).includes(actual)) return false;
    if (op === "is" && operand === "null" && row[key] !== null && row[key] !== undefined) return false;
    if (op === "not" && operand === "is.null" && (row[key] === null || row[key] === undefined)) return false;
    if (op === "gte" && !atLeast(row[key], operand)) return false;
    if (key === "or" && !orAny(row, expression)) return false;
  }
  return true;
}

/** PostgREST quotes values containing commas, parentheses or quotes inside an in() list. */
function inValues(operand: string): string[] {
  const values: string[] = [];
  let value = "",
    quoted = false,
    escaped = false;
  for (const char of operand.slice(1, -1)) {
    if (escaped) {
      value += char;
      escaped = false;
    } else if (char === "\\" && quoted) escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else value += char;
  }
  values.push(value);
  return values;
}

/** PostgREST's `gte` on a timestamp column: a null never matches. */
function atLeast(value: unknown, operand: string): boolean {
  return typeof value === "string" && Date.parse(value) >= Date.parse(operand);
}

/** `or=(a.gte.x,b.not.is.null)`: the dashboard's `or` terms, a timestamp at or after its bound or a column set. */
function orAny(row: Row, expression: string): boolean {
  return expression
    .slice(1, -1)
    .split(",")
    .some((term) => {
      const [column = "", op, ...rest] = term.split(".");
      if (op === "not" && rest.join(".") === "is.null") return row[column] !== null && row[column] !== undefined;
      if (op === "eq") return String(row[column]) === rest.join(".");
      return op === "gte" && atLeast(row[column], rest.join("."));
    });
}

function project(table: string, row: Row, select: string | null): Row | Fail {
  const columns = !select || select === "*" ? null : select.split(",").map((column) => column.trim());
  if (table === "github_connections") {
    if (!columns || columns.includes("refresh_token_enc")) {
      return { status: 401, code: "42501", message: "permission denied for table github_connections" };
    }
  }
  if (table === "orgs" && !columns) {
    return { status: 401, code: "42501", message: "permission denied for table orgs" };
  }
  if (!columns) return row;
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}

async function rest(request: Request, url: URL): Promise<Response> {
  const userId = viewer(request);
  if (!userId) return json({ message: "JWT required", code: "PGRST301" }, 401);
  const path = url.pathname.replace("/rest/v1/", "");
  const range = request.headers.get("range")?.match(/^(\d+)-(\d*)$/);
  if (range && !url.searchParams.has("offset") && !url.searchParams.has("limit")) {
    url.searchParams.set("offset", range[1]!);
    if (range[2]) url.searchParams.set("limit", String(Number(range[2]) - Number(range[1]) + 1));
  }

  // A set-returning function is filtered, ordered, counted and paged by PostgREST like a table.
  if (path === "rpc/sandbox_list_metadata") return page(sandboxListMetadata(userId), url);
  if (path.startsWith("rpc/")) return rpc(path.slice(4), await request.json(), userId);

  const table = path;
  const prefer = request.headers.get("prefer") ?? "";
  const wantRows = prefer.includes("return=representation");
  const select = url.searchParams.get("select");

  if (request.method === "GET") {
    // Column grants apply to the query, even when filtering or paging returns no rows.
    if (table === "credentials") {
      const columns = select?.split(",").map((column) => column.trim());
      if (!select || !columns || columns.includes("*") || columns.includes("value_enc")) {
        return pgError({ status: 401, code: "42501", message: "permission denied for table credentials" });
      }
    }
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
  if (path === "/otp") {
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
  const target = state.sandboxes.find((row) => row.id === args.id);
  const visible = visibleRows("sandboxes", userId).some((row) => row === target);
  const text = (value: unknown, isError = false) =>
    reply({ content: [{ type: "text", text: JSON.stringify(value) }], isError });
  if (!target || !visible) return text("not found", true);
  if (driving && target.provider === "modal" && target.credential_id === null) {
    // As #603's server answers a legacy unbound Modal sandbox: a typed refusal, never a silent default account.
    return reply({
      content: [
        {
          type: "text",
          text: "This legacy Modal sandbox needs an explicit account binding by its owner. Stop it safely, then its owner chooses an account on the sandbox's dashboard page or runs 'armada bind-credential <sandbox-id> --credential-id <account-uuid>'. Its workspace and conversations are retained.",
        },
        { type: "text", text: "error code: credential_binding_required" },
      ],
      isError: true,
    });
  }
  const events = state.events.get(String(target.id)) ?? [];
  state.events.set(String(target.id), events);
  const conversations = (target.conversation_ids ?? []) as string[];

  switch (message.params?.name) {
    case "status":
      return text({
        status: target.status,
        prompt: null,
        usage: {
          computeSeconds: target.usage_runtime_seconds ?? null,
          turnCount: (target.usage_turns as Row | undefined)?.turnCount ?? null,
          turns: (target.usage_turns as Row | undefined)?.turns ?? [],
        },
      });
    case "logs": {
      const since = typeof args.since_cursor === "string" ? Number(args.since_cursor) : 0;
      return text({ events: events.slice(since), cursor: String(events.length), hasMore: false });
    }
    case "send": {
      // As the server does: the named conversation, else the latest, else a new one; the sandbox is running after.
      const conversationId =
        typeof args.conversation_id === "string"
          ? args.conversation_id
          : (conversations.at(-1) ?? `conv-${events.length}`);
      if (!conversations.includes(conversationId)) target.conversation_ids = [...conversations, conversationId];
      target.status = "running";
      // A send to a stopped sandbox restores it: the server clears its stop time.
      target.stopped_at = null;
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

/** Fixture transport only: supported owner account changes retain the logical workspace, without a provider probe. */
function bindCredential(body: Row, userId: string | null): Response {
  if (!userId) return json({ error: "Unauthorized." }, 401);
  const refuse = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
  const target = state.sandboxes.find((row) => row.id === body.id);
  if (
    !target ||
    target.owner_id !== userId ||
    !isMember(target.org_id, userId) ||
    (body.org !== undefined && body.org !== target.org_id)
  )
    return refuse(404, "not_found", "Only the sandbox owner can choose its account binding.");
  const availability = accountBindingAvailability({
    provider: String(target.provider),
    boatRuntime: target.boat_runtime === true,
  });
  if (!availability.available) return refuse(409, "credential_binding_unsupported", availability.reason);
  const latestPrompt = [...(state.events.get(String(target.id)) ?? [])]
    .reverse()
    .find((event) => event.kind === "prompt");
  if (
    !["ready", "stopped"].includes(String(target.status)) ||
    (target.status === "ready" && latestPrompt?.status === "running")
  )
    return refuse(409, "credential_binding_unsafe", "Wait for the running turn or lifecycle operation to finish.");
  const account = state.credentials.find(
    (row) =>
      row.id === body.credentialId &&
      MODEL_KINDS[String(row.kind)] === target.harness &&
      row.status === "active" &&
      (!row.expires_at || Date.parse(String(row.expires_at)) > Date.now()) &&
      ((row.scope === "user" && row.owner_id === userId) || (row.scope === "org" && row.owner_id === target.org_id)),
  );
  if (!account) return refuse(400, "invalid", "That account cannot be used for this sandbox.");
  target.credential_id = account.id;
  target.credential_version = account.version;
  target.status = "stopped";
  target.stopped_at ??= new Date().toISOString();
  return json({
    id: target.id,
    credentialId: account.id,
    credentialVersion: account.version,
    harness: target.harness,
    status: "bound",
  });
}

/**
 * `POST /api/v1/sandbox/launch`, as the Armada API serves it: the golden must be visible in the org, `repo` must be
 * exactly one of its `config.repos[].dir`, and every named connection is the caller's to use in the org, personal or
 * org, and connected (#681: the legacy visibility plays no part). The sandbox row records what was launched.
 */
/** Remote metadata boundary only: installs remain the launch service's contract. */
function skillCatalogRoute(route: string, body: Row, request: Request): Response {
  const user = viewer(request);
  if (!user) return controlFail(401, "unauthorized", "Sign in again.");
  if (!isMember(body.org, user)) return controlFail(404, "not_found", "No such organization.");
  if (route === "skillpack/versions")
    return json({
      versions:
        body.source === "private" ? (body.reference === "release-notes" ? ["1.0.0"] : ["2.1.0", "2.0.0"]) : ["1.4.0"],
    });
  return json({
    items:
      body.source === "private"
        ? [
            {
              reference: "review-code",
              name: "Code review",
              description: "Review changes for correctness, security and test coverage.",
              visibility: "private",
              versions: ["2.1.0"],
            },
            {
              reference: "release-notes",
              name: "Release notes",
              description: "Turn shipped changes into concise release notes.",
              visibility: "private",
              versions: ["1.0.0"],
            },
          ]
        : [
            {
              reference: "example/browser-testing",
              name: "Browser testing",
              description: "Check real browser flows and capture readable evidence.",
              visibility: "public",
              versions: ["1.4.0"],
            },
          ],
    nextOffset: null,
  });
}

function launchRoute(body: Row, userId: string | null): Response {
  if (!userId) return controlFail(401, "unauthorized", "Sign in again.");
  state.launches.push(body);
  // #681: omitted connections are the caller's enabled defaults, snapshotted here; every one must be connected.
  const ids = Array.isArray(body.connections)
    ? body.connections.map(String)
    : visibleConnections(String(body.org), userId)
        .filter((row) => row.defaultForLaunch && row.status !== "disabled")
        .map((row) => String(row.id));
  for (const cid of ids) {
    const connection = visibleConnections(String(body.org), userId).find((row) => row.id === cid);
    if (!connection) return controlFail(404, "not_found", "A connection is not available.");
    if (connection.status !== "connected")
      return controlFail(
        403,
        "forbidden",
        "Please reconnect every selected MCP connection before launching, or explicitly select connections to continue without it.",
      );
  }
  if (body.provider === "docker") {
    if (!isMember(body.org, userId)) return controlFail(403, "forbidden", "Only organization members can launch.");
    const host = (body.org === LARGE ? largeHosts() : []).find((row) => row.id === body.hostId);
    if (!host) return controlFail(404, "not_found", "No such host.");
    if (host.state !== "online") return controlFail(409, "conflict", "The host is not online.");
    const account = state.credentials.find(
      (row) =>
        row.id === body.credentialId &&
        ((row.scope === "user" && row.owner_id === userId) || (row.scope === "org" && row.owner_id === body.org)),
    );
    if (account?.status !== "active" || MODEL_KINDS[String(account.kind)] !== body.harness)
      return controlFail(400, "invalid", "That account cannot run this agent.");
    const row = sandbox(
      crypto.randomUUID(),
      `docker_launched_${++sequence}`,
      "",
      userId,
      String(body.harness),
      body.prompt ? "running" : "ready",
      new Date().toISOString(),
    );
    Object.assign(row, {
      org_id: body.org,
      provider: "docker",
      golden_id: null,
      boat_id: null,
      docker_host_id: body.hostId,
      connections: ids,
      credential_id: body.credentialId,
      credential_version: account.version,
      model: body.model,
      reasoning_effort: body.reasoningEffort,
      visibility: "private",
    });
    state.sandboxes.unshift(row);
    return json({ sandbox: { id: row.id, provider: "docker" } });
  }
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
  if (body.credentialId !== undefined) {
    const account = state.credentials.find(
      (row) =>
        row.id === body.credentialId &&
        ((row.scope === "user" && row.owner_id === userId) || (row.scope === "org" && row.owner_id === body.org)),
    );
    if (account?.status !== "active" || MODEL_KINDS[String(account.kind)] !== body.harness)
      return controlFail(400, "invalid", "That account cannot run this agent.");
  }
  const sized = "size_policy" in source;
  if (sized && body.size !== undefined && !SIZES.includes(String(body.size)))
    return controlFail(400, "invalid_request", "Size must be small, medium, large or xlarge.");
  const row = sandbox(
    crypto.randomUUID(),
    `bx_launched_${++sequence}`,
    String(source.id),
    userId,
    String(body.harness),
    body.prompt ? "running" : "ready",
    new Date().toISOString(),
  );
  row.org_id = source.org_id;
  row.model = body.model;
  row.reasoning_effort = body.reasoningEffort;
  if (body.armadaAccess) row.visibility = "private";
  else if (body.visibility !== undefined) row.visibility = body.visibility;
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

function vaultItem(
  itemId: string,
  kind: "variable" | "secret",
  scope: "personal" | "org",
  owner: string,
  name: string,
  extra: Row = {},
): Row {
  return {
    id: itemId,
    kind,
    org_id: ACME,
    owner_id: owner,
    scope,
    name,
    version: 1,
    epoch: 1,
    status: "active",
    expires_at: null,
    created_at: "2026-11-09T10:00:00.000Z",
    updated_at: "2026-11-10T10:00:00.000Z",
    ...extra,
  };
}

/** The metadata DTO of `application-vault.ts`: never a value, never the sealed secret. */
function vaultDto(row: Row): Row {
  return {
    id: row.id,
    orgId: row.org_id,
    ownerId: row.owner_id,
    scope: row.scope,
    name: row.name,
    version: row.version,
    epoch: row.epoch,
    status: row.status,
    ...(row.kind === "secret" ? { expiresAt: row.expires_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `POST /api/v1/{variables,secrets}/<operation>`, with the server's membership, admin and version rules. */
function vaultRoute(route: string, body: Row, request: Request): Response {
  const userId = viewer(request);
  if (!userId) return json({ error: "Unauthorized." }, 401);
  const [resource, operation] = route.split("/");
  const kind = resource === "variables" ? "variable" : "secret";
  const refuse = (status: number, code: string, message: string) => controlFail(status, code, message);
  const invalid = () => refuse(400, "invalid", "Invalid application vault request.");
  const denied = () => refuse(403, "forbidden", "Application vault access denied.");
  if (kind === "secret" && operation === "read") return invalid();
  if (!isMember(body.org, userId)) return denied();
  const visible = (row: Row) =>
    row.kind === kind && row.org_id === body.org && (row.scope === "org" || row.owner_id === userId);
  const nameOk = (value: unknown) =>
    typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) && !/^(ARMADA_|GITHUB_|GH_)/.test(value);
  const taken = (name: unknown, scope: unknown, except?: unknown) =>
    state.vault.some(
      (row) =>
        row.kind === kind &&
        row.org_id === body.org &&
        row.status !== "deleted" &&
        row.name === name &&
        row.scope === scope &&
        (scope === "org" || row.owner_id === userId) &&
        row.id !== except,
    );
  const now = new Date().toISOString();
  if (operation === "list")
    return json({ items: state.vault.filter((row) => visible(row) && row.status !== "deleted").map(vaultDto) });
  if (operation === "set") {
    if (body.scope !== "personal" && body.scope !== "org") return invalid();
    if (body.scope === "org" && !isAdmin(body.org, userId)) return denied();
    if (!nameOk(body.name) || typeof body.value !== "string" || (kind === "secret" && !body.value)) return invalid();
    if (taken(body.name, body.scope)) return refuse(409, "conflict", "An application vault name is already in use.");
    const row = vaultItem(id(++sequence), kind, body.scope, userId, String(body.name), {
      org_id: body.org,
      created_at: now,
      updated_at: now,
      ...(kind === "secret" ? { sealed: body.value } : { value: body.value }),
    });
    state.vault.push(row);
    return json({ item: vaultDto(row) });
  }
  const row = state.vault.find((item) => item.id === body.id && visible(item));
  if (!row) return refuse(404, "not_found", "Application vault resource unavailable.");
  if (operation === "read") {
    if (row.status !== "active") return refuse(404, "not_found", "Application vault resource unavailable.");
    return json({ item: vaultDto(row), value: row.value });
  }
  if (row.scope === "org" && !isAdmin(body.org, userId)) return denied();
  if (row.version !== body.expectedVersion) return refuse(409, "conflict", "Application vault version changed.");
  if ((operation === "update" || operation === "rotate") && row.status !== "active")
    return refuse(409, "conflict", "Application vault resource is not active.");
  if (operation === "update" || operation === "rotate") {
    if (body.name !== undefined && !nameOk(body.name)) return invalid();
    if (body.name !== undefined && taken(body.name, row.scope, row.id))
      return refuse(409, "conflict", "An application vault name is already in use.");
    if (operation === "rotate" && (typeof body.value !== "string" || !body.value)) return invalid();
    if (body.name !== undefined) row.name = body.name;
    if (body.value !== undefined) row[kind === "secret" ? "sealed" : "value"] = body.value;
  } else if (operation === "revoke" || operation === "delete") {
    row.status = operation === "revoke" ? "revoked" : "deleted";
    delete row.sealed;
    delete row.value;
  } else return invalid();
  row.version = Number(row.version) + 1;
  row.epoch = Number(row.epoch) + 1;
  row.updated_at = now;
  return json({ item: vaultDto(row) });
}

function routineRow(
  routineId: string,
  scope: "personal" | "org",
  ownerId: string,
  name: string,
  status: "enabled" | "paused",
  templateId: string,
  templateRevision: number,
): Row {
  return {
    id: routineId,
    orgId: ACME,
    ownerId,
    scope,
    name,
    templateId,
    templateRevision,
    prompt: "Review the repository and summarize what changed. Do not edit files.",
    intervalHours: scope === "org" ? 24 : 6,
    ttlSeconds: 3600,
    maxRunsPerDay: 4,
    status,
    version: 2,
    nextDueAt: status === "enabled" ? new Date(Date.now() + 20 * 3600000).toISOString() : null,
    consecutiveFailures: 0,
    pauseReason: null,
    createdAt: "2026-11-09T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z",
  };
}

/** Browser protocol peer for the real routine API, not a scheduler simulation. */
async function routineRoute(route: string, body: Row, request: Request): Promise<Response> {
  const userId = viewer(request);
  if (!userId) return controlFail(401, "unauthorized", "Sign in.");
  const operation = route.slice("routines/".length);
  const fields: Record<string, string[]> = {
    list: ["org"],
    get: ["org", "id"],
    history: ["org", "id"],
    create: [
      "org",
      "scope",
      "name",
      "templateId",
      "templateRevision",
      "prompt",
      "intervalHours",
      "ttlSeconds",
      "maxRunsPerDay",
    ],
    enable: ["org", "id", "expectedVersion"],
    pause: ["org", "id", "expectedVersion"],
    delete: ["org", "id", "expectedVersion"],
  };
  if (!fields[operation] || Object.keys(body).some((key) => !fields[operation]!.includes(key)))
    return controlFail(400, "invalid", "Invalid routine request.");
  if (!isMember(body.org, userId)) return controlFail(403, "forbidden", "Routine access denied.");
  const visible = (r: Row) => r.orgId === body.org && (r.scope === "org" || r.ownerId === userId);
  if (operation === "list") return json({ items: state.routines.filter((r) => visible(r) && r.status !== "deleted") });
  const admin = state.members.some((m) => m.org_id === body.org && m.user_id === userId && m.role === "admin");
  if (operation === "create") {
    if (!["personal", "org"].includes(String(body.scope)) || (body.scope === "org" && !admin))
      return controlFail(403, "forbidden", "Routine administrator permission required.");
    const template = state.templates.find(
      (t) =>
        t.id === body.templateId &&
        t.orgId === body.org &&
        t.status === "active" &&
        (t.scope === "org" || (t.ownerId === userId && body.scope === "personal")),
    );
    const revision = state.templateRevisions.find(
      (r) => r.templateId === body.templateId && r.revision === body.templateRevision,
    );
    if (!template || !revision) return controlFail(404, "not_found", "Routine template revision unavailable.");
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      typeof body.prompt !== "string" ||
      !body.prompt.trim() ||
      !Number.isInteger(body.intervalHours) ||
      Number(body.intervalHours) < 1 ||
      Number(body.intervalHours) > 720
    )
      return controlFail(400, "invalid", "Invalid routine request.");
    const item = {
      ...routineRow(
        id(++sequence),
        body.scope as "personal" | "org",
        userId,
        body.name,
        "paused",
        String(body.templateId),
        Number(body.templateRevision),
      ),
      orgId: body.org,
      prompt: body.prompt,
      intervalHours: body.intervalHours,
      ttlSeconds: body.ttlSeconds ?? 3600,
      maxRunsPerDay: body.maxRunsPerDay ?? 24,
      version: 1,
    };
    state.routines.push(item);
    return json({ item });
  }
  const item = state.routines.find(
    (r) => r.id === body.id && visible(r) && (r.status !== "deleted" || operation === "history"),
  );
  if (!item) return controlFail(404, "not_found", "Routine unavailable.");
  if (operation === "get") return json({ item });
  if (operation === "history")
    return json({
      items: state.routineHistory
        .filter((r) => r.routineId === item.id)
        .map((r) => ({ ...r, sandboxId: item.ownerId === userId ? r.sandboxId : null }))
        .slice(0, 100),
    });
  if (item.scope === "org" && !admin)
    return controlFail(403, "forbidden", "Routine administrator permission required.");
  if (body.expectedVersion !== item.version) return controlFail(409, "conflict", "Routine version changed.");
  Object.assign(item, {
    status: operation === "enable" ? "enabled" : operation === "delete" ? "deleted" : "paused",
    version: Number(item.version) + 1,
    nextDueAt:
      operation === "enable" ? new Date(Date.now() + Number(item.intervalHours) * 3600000).toISOString() : null,
    updatedAt: new Date().toISOString(),
  });
  return json({ item, ...(operation === "pause" ? { admittedRunsMayFinish: true } : {}) });
}

function templateRow(
  templateId: string,
  scope: "personal" | "org",
  owner: string,
  name: string,
  revision: number,
): Row {
  return {
    id: templateId,
    orgId: ACME,
    ownerId: owner,
    scope,
    name,
    currentRevision: revision,
    status: "active",
    createdAt: "2026-11-09T10:00:00.000Z",
    updatedAt: "2026-11-10T10:00:00.000Z",
  };
}

function templateRevision(templateId: string, revision: number, definition: Row): Row {
  const harness = definition.harness === "codex" ? "codex" : "claude";
  return {
    templateId,
    id: crypto.randomUUID(),
    revision,
    definition: {
      goldenBinding: null,
      model: harness === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5",
      reasoningEffort: "high",
      connections: [],
      variables: [],
      skills: [],
      ...definition,
    },
  };
}

/**
 * `POST /api/v1/templates/<operation>` as #938's template service answers it: strict fields, owner-or-org
 * visibility, admin-only org writes, optimistic revisions and a launch replayed by its request key.
 */
function templateRoute(route: string, body: Row, request: Request): Response {
  const userId = viewer(request);
  if (!userId) return json({ error: "Unauthorized." }, 401);
  const operation = route.slice("templates/".length);
  const allowed: Record<string, string[]> = {
    create: ["org", "name", "scope", "definition"],
    list: ["org"],
    get: ["org", "id", "revision"],
    publish: ["org", "id", "expectedRevision", "definition"],
    delete: ["org", "id", "expectedRevision"],
    launch: ["org", "id", "revision", "requestKey", "prompt", "ttlSeconds", "size", "repo", "modelAccount"],
  };
  const invalid = () => controlFail(400, "invalid", "Invalid template request.");
  const fields = allowed[operation];
  if (!fields || Object.keys(body).some((key) => !fields.includes(key))) return invalid();
  if (!isMember(body.org, userId)) return controlFail(403, "forbidden", "Template access denied.");
  const visible = (row: Row) =>
    row.orgId === body.org && row.status === "active" && (row.scope === "org" || row.ownerId === userId);
  // The `launch_templates_name` unique index: one active name per org and scope (per owner when personal).
  const nameTaken = (name: unknown, scope: unknown) =>
    state.templates.some(
      (row) =>
        row.orgId === body.org &&
        row.status === "active" &&
        row.scope === scope &&
        row.name === name &&
        (scope === "org" || row.ownerId === userId),
    );
  const revisionOf = (row: Row, revision = row.currentRevision) =>
    state.templateRevisions.find((r) => r.templateId === row.id && r.revision === revision);
  const dto = (r: Row) => ({ id: r.id, revision: r.revision, definition: r.definition });
  /** The template service's reference checks, in its words: an org template binds only org resources. */
  const definition = (scope: unknown, input: unknown): Row | Response => {
    if (typeof input !== "object" || input === null) return invalid();
    const d = input as Row;
    const golden = liveGoldens(userId).find((row) => row.id === d.goldenId && row.org_id === body.org);
    if (
      !golden ||
      golden.provider !== d.provider ||
      !golden.provider_snapshot_id ||
      (scope === "org" && golden.visibility !== "org")
    )
      return controlFail(409, "conflict", "Template launch refused: environment_unavailable.");
    if (d.harness !== "claude" && d.harness !== "codex") return invalid();
    for (const cid of (d.connections ?? []) as string[]) {
      const c = visibleConnections(String(body.org), userId).find((row) => row.id === cid);
      if (!c || c.status !== "connected" || (scope === "org" && c.scope !== "org"))
        return controlFail(409, "conflict", "Template launch refused: connection_unavailable.");
    }
    for (const binding of (d.variables ?? []) as Row[]) {
      const v = state.vault.find(
        (row) =>
          row.id === binding.variableId &&
          row.kind === "variable" &&
          row.status === "active" &&
          (row.scope === "org" || row.owner_id === userId),
      );
      if (!v || (scope === "org" && v.scope !== "org"))
        return controlFail(409, "conflict", "Template launch refused: variable_unavailable.");
      if (v.version !== binding.version)
        return controlFail(409, "conflict", "Template launch refused: variable_version_changed.");
    }
    if (d.modelAccount !== undefined) {
      const pinned = d.modelAccount as Row;
      const account = state.credentials.find((row) => row.id === pinned.id && row.status === "active");
      if (!account) return controlFail(409, "conflict", "Template launch refused: model_account_unavailable.");
      if (account.version !== pinned.version)
        return controlFail(409, "conflict", "Template launch refused: model_account_version_changed.");
    }
    return {
      ...(d.modelAccount === undefined ? {} : { modelAccount: d.modelAccount }),
      goldenId: d.goldenId,
      provider: d.provider,
      goldenBinding: null,
      harness: d.harness,
      model: d.model ?? (d.harness === "codex" ? "gpt-6.2-sol" : "claude-opus-5-5"),
      reasoningEffort: d.reasoningEffort ?? "high",
      connections: d.connections ?? [],
      variables: d.variables ?? [],
      ...(Array.isArray(d.secrets) && d.secrets.length ? { secrets: d.secrets } : {}),
      skills: d.skills ?? [],
    };
  };
  const now = new Date().toISOString();
  if (operation === "list")
    return json({
      items: state.templates.filter(visible).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    });
  if (operation === "create") {
    if (body.scope !== "personal" && body.scope !== "org") return invalid();
    if (typeof body.name !== "string" || !body.name.trim()) return invalid();
    if (body.scope === "org" && !isAdmin(body.org, userId))
      return controlFail(403, "forbidden", "Template administrator permission required.");
    const def = definition(body.scope, body.definition);
    if (def instanceof Response) return def;
    if (nameTaken(body.name, body.scope))
      return controlFail(409, "conflict", "Template name or request key already exists.");
    const row: Row = {
      ...templateRow(id(++sequence), body.scope, userId, body.name, 1),
      orgId: body.org,
      createdAt: now,
      updatedAt: now,
    };
    const revision = { templateId: row.id, id: crypto.randomUUID(), revision: 1, definition: def };
    state.templates.push(row);
    state.templateRevisions.push(revision);
    return json({ item: row, revision: dto(revision) });
  }
  const row = state.templates.find((item) => item.id === body.id && visible(item));
  if (!row) return controlFail(404, "not_found", "Template unavailable.");
  if (operation === "get") {
    const revision = revisionOf(row, body.revision === undefined ? row.currentRevision : body.revision);
    if (!revision) return controlFail(404, "not_found", "Template revision unavailable.");
    return json({ item: row, revision: dto(revision) });
  }
  if (operation === "launch") {
    // Keys are scoped to the actor and the org.
    const key = `${body.org}:${userId}:${body.requestKey}`;
    const digest = JSON.stringify(body);
    const previous = state.templateRequests.get(key);
    if (previous) {
      if (previous.digest !== digest)
        return controlFail(409, "conflict", "Request key already used with a different request.");
      return json(previous.result);
    }
    const revision = revisionOf(row, body.revision);
    if (!revision) return controlFail(404, "not_found", "Template revision unavailable.");
    const def = revision.definition as Row;
    const golden = liveGoldens(userId).find((g) => g.id === def.goldenId);
    let result: Row;
    if (!golden) {
      result = {
        requestId: crypto.randomUUID(),
        state: "failed",
        id: crypto.randomUUID(),
        reason: "environment_unavailable",
      };
    } else {
      const launched = sandbox(
        crypto.randomUUID(),
        `bx_template_${++sequence}`,
        String(golden.id),
        userId,
        String(def.harness),
        body.prompt ? "running" : "ready",
        now,
      );
      launched.org_id = golden.org_id;
      launched.model = def.model;
      launched.reasoning_effort = def.reasoningEffort;
      launched.provider = golden.provider;
      launched.connections = def.connections;
      launched.repository_dir = body.repo ?? null;
      state.sandboxes.unshift(launched);
      result = { requestId: crypto.randomUUID(), state: "succeeded", id: launched.id, status: launched.status };
    }
    // The server answers its frozen manifest, readable values included: the dashboard must never pass it on.
    result.manifest = { version: 1, templateId: row.id, variables: { APP_REGION: "manifest-canary-5e1d" } };
    state.templateRequests.set(key, { digest, result });
    return json(result);
  }
  if (row.scope === "org" && !isAdmin(body.org, userId))
    return controlFail(403, "forbidden", "Template administrator permission required.");
  if (row.currentRevision !== body.expectedRevision) return controlFail(409, "conflict", "Template revision changed.");
  if (operation === "delete") {
    Object.assign(row, { status: "deleted", updatedAt: now });
    return json({ item: row });
  }
  const def = definition(row.scope, body.definition);
  if (def instanceof Response) return def;
  row.currentRevision = Number(row.currentRevision) + 1;
  row.updatedAt = now;
  const revision = { templateId: row.id, id: crypto.randomUUID(), revision: row.currentRevision, definition: def };
  state.templateRevisions.push(revision);
  return json({ item: row, revision: dto(revision) });
}

/* The registry's control API (issue #522): POST /api/v1/mcp/<operation>, user JWT as the bearer. */

const DASHBOARD = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:3100";
const OAUTH_HOST = "oauth.test";
const ISSUER = `http://127.0.0.1:${PORT}`;
/** Pending browser sign-ins by state: the API, not the URL, knows which user and connection a state is for. */
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
  if (!userId) return controlFail(401, "unauthorized", "Sign in.");
  const fresh = () => `mock-invitation-${++sequence}-0123456789abcdef`;
  if (route === "preview" || route === "accept") {
    const row = state.invitations.find((item) => item.token === body.token);
    const email = users.get(userId)?.email;
    // The server's order: the address must match before anything about the org is said. The first failing check wins.
    const checks: [boolean, string][] = [
      [!row, "not_found"],
      [row?.email !== email, "wrong_email"],
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
  if (route === "list") {
    return json({ invitations: state.invitations.filter((row) => row.orgId === org.id).map(invitationDto) });
  }
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
      delivery: "sent",
      token: fresh(),
    };
    state.invitations.push(row);
    return json({ invitation: invitationDto(row) });
  }
  const row = state.invitations.find((item) => item.id === body.id && item.orgId === org.id);
  if (row?.status !== "pending") return controlFail(404, "not_found", "Invitation not found.");
  if (route === "resend") {
    row.token = fresh();
    row.delivery = "sent";
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

function mcpControl(operation: string, body: Row, userId: string | null): Response {
  if (!userId) return controlFail(401, "unauthorized", "Sign in again.");
  if (operation === "oauth/callback") return oauthCallback(body, userId);
  const org = String(body.org ?? "");
  if (!isMember(org, userId)) return controlFail(403, "forbidden", "You are not a member of that organization.");
  if (operation === "list") {
    return json({ connections: visibleConnections(org, userId).map(connectionDto) });
  }
  if (operation === "catalog") {
    return json({ services: CATALOG });
  }
  if (operation === "sandbox-connections") {
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
 * later, here on the first status read (`golden/build/status`). The same requester, org and
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
  status: { state: string; phase: string; errorCode: string | null; failureReason?: string | null; result: Row | null };
};
const goldenJobs = new Map<string, GoldenJob>();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

function jobJson(job: GoldenJob): Row {
  return { jobId: job.id, ...job.status };
}

async function goldenBuild(route: string, body: Row, request: Request): Promise<Response> {
  const userId = viewer(request);
  if (!userId) return json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
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
  return json(jobJson(job), 202);
}

async function goldenJobStatus(body: Row, request: Request): Promise<Response> {
  const userId = viewer(request);
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
    const result = publishGoldenBuild(job.route, job.body, job.owner);
    job.status = result
      ? { state: "succeeded", phase: "complete", errorCode: null, result }
      : { state: "failed", phase: "publish", errorCode: "build_failed", result: null };
  }
  return json(jobJson(job));
}

function findGoldenJob(body: Row, request: Request): Response {
  const userId = viewer(request);
  if (!userId) return json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
  const target = rebuildTarget(body, userId);
  if (target instanceof Response) return target;
  const job = [...goldenJobs.values()]
    .reverse()
    .find(
      (item) =>
        item.owner === userId &&
        item.body.org === target.org_id &&
        item.body.name === target.name &&
        (item.body.provider ?? (item.route === "golden/update" ? target.provider : "boat")) === target.provider &&
        ["queued", "running", "recovery_required"].includes(item.status.state),
    );
  return json({ build: job ? jobJson(job) : null });
}

function cancelGoldenJob(body: Row, request: Request): Response {
  const userId = viewer(request);
  if (!userId) return json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
  const job = goldenJobs.get(String(body.jobId));
  if (!job || job.owner !== userId || !isMember(job.body.org, userId) || (body.org && body.org !== job.body.org))
    return json({ error: { code: "not_found", message: "No such build." } }, 404);
  if (job.status.state !== "queued" || job.status.phase !== "queued")
    return json(
      {
        error: {
          code: "conflict",
          message:
            "Only a queued, never-started build can be cancelled. Check its status; running builds need recovery.",
        },
      },
      409,
    );
  job.status = {
    state: "failed",
    phase: "queued",
    errorCode: "build_failed",
    failureReason:
      "detail:Build cancelled by its owner before a builder started. Start a new build request when ready.",
    result: null,
  };
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
    // Absent means Boat, as on the server.
    const provider = (body.provider ?? "boat") as "boat" | "modal";
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
  if (!userId) return json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
  if (!isMember(body.org, userId))
    return json({ error: { code: "forbidden", message: "You are not a member of this org." } }, 403);
  const provider = body.provider ?? "boat";
  if (provider !== "boat" && provider !== "modal")
    return json({ error: { code: "invalid", message: "Provider is boat or modal." } }, 400);
  const entry = state.capabilities[provider];
  return json(
    {
      provider,
      maxGoldens: entry.maxGoldens,
      bindings: state.goldens
        .filter(
          (g) => g.org_id === body.org && g.provider === provider && (g.visibility === "org" || g.owner_id === userId),
        )
        .map((g) => ({ goldenId: g.id, relation: "current_backend" })),
    },
    200,
    { "cache-control": "no-store" },
  );
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
  if (!userId) return controlFail(401, "unauthorized", "Sign in.");
  const org = state.orgs.find((row) => row.id === body.org);
  if (!org || !isMember(org.id, userId)) return controlFail(403, "forbidden", "You are not a member of this org.");
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

/* Named model accounts (#603): creds/list and creds/accounts/{set,rename,default,remove}, user JWT as the bearer. */

const MODEL_KINDS: Record<string, Harness | undefined> = Object.fromEntries(
  MODEL_CREDENTIAL_KINDS.map((kind) => [kind, harnessForCredential(kind)]),
);

/** The safe DTO: never `value_enc`, never the owner. Scope is where the row sits in `creds/list`. */
function accountDto(row: Row): Row {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    isDefault: row.is_default === true,
    status: row.status ?? "active",
    expiresAt: row.expires_at ?? null,
    updatedAt: row.updated_at ?? row.created_at,
    version: row.version ?? 1,
    ...(row.rateLimited === true ? { rateLimited: true } : {}),
    ...(typeof row.runningAgents === "number" ? { runningAgents: row.runningAgents } : {}),
    ...(row.maxAgents === null || typeof row.maxAgents === "number" ? { maxAgents: row.maxAgents } : {}),
  };
}

/* The Skillpack key (#957): `creds/set` and `creds/rm`, one per scope, never a value in an answer. */
const SKILLPACK_PAT = /^cmp_pat_[a-f0-9]{48}$/;

function skillpackDto(row: Row): Row {
  return {
    kind: row.kind,
    status: row.status ?? "active",
    expiresAt: row.expires_at ?? null,
    updatedAt: row.updated_at ?? row.created_at,
    createdAt: row.created_at,
  };
}

function singleton(route: string, body: Row, scope: "user" | "org", owner: string): Response {
  if (body.kind !== "skillpack") return controlFail(400, "invalid", "Unknown credential.");
  const mine = (row: Row) => row.scope === scope && row.owner_id === owner && row.kind === "skillpack";
  const now = new Date().toISOString();
  if (route === "creds/rm") {
    const before = state.credentials.length;
    state.credentials = state.credentials.filter((row) => !mine(row));
    return before === state.credentials.length
      ? controlFail(404, "not_found", "No such credential is stored.")
      : json({ ok: true });
  }
  if (typeof body.value !== "string" || !SKILLPACK_PAT.test(body.value.trim()))
    return controlFail(
      400,
      "invalid",
      "A Skillpack token starts with cmp_pat_ followed by 48 lowercase hexadecimal characters.",
    );
  state.credentials = state.credentials.filter((row) => !mine(row));
  state.credentials.push({
    id: crypto.randomUUID(),
    scope,
    owner_id: owner,
    kind: "skillpack",
    // Sealed as the server does: the mock keeps random bytes, never the text it was sent.
    value_enc: `\\x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`,
    created_at: now,
    updated_at: now,
    status: "active",
  });
  return json({ ok: true });
}

function accounts(route: string, body: Row, request: Request): Response {
  const userId = viewer(request);
  if (!userId) return controlFail(401, "unauthorized", "Sign in again.");
  const model = (row: Row) => String(row.kind) in MODEL_KINDS;
  if (route === "creds/list") {
    const org = state.orgs.find((row) => row.id === body.org && isMember(row.id, userId));
    // As the server: every kind of the scope, the Skillpack key (#957) as kind and dates only.
    const listed = (row: Row) => model(row) || row.kind === "skillpack";
    const rows = (scope: string, owner: unknown) =>
      state.credentials
        .filter((row) => row.scope === scope && row.owner_id === owner && listed(row) && row.status !== "deleted")
        .map((row) => (model(row) ? accountDto(row) : skillpackDto(row)));
    return json({
      defaults: state.agentDefaults[userId] ?? [],
      user: rows("user", userId),
      orgs: org ? [{ id: org.id, name: org.name, credentials: rows("org", org.id) }] : [],
    });
  }
  if (route === "creds/defaults/set") {
    if (!["claude", "codex", "opencode"].includes(String(body.harness)))
      return controlFail(400, "invalid", "Unknown agent.");
    if (body.credentialId !== null) {
      const account = state.credentials.find(
        (row) =>
          row.id === body.credentialId &&
          row.status !== "deleted" &&
          ((row.scope === "user" && row.owner_id === userId) ||
            (row.scope === "org" && row.owner_id === body.org && isMember(row.owner_id, userId))),
      );
      if (
        !account ||
        !harnessesForCredential(account.kind as Parameters<typeof harnessesForCredential>[0]).includes(
          body.harness as Harness,
        )
      )
        return controlFail(404, "not_found", "No compatible visible account.");
    }
    state.agentDefaults[userId] = [
      ...(state.agentDefaults[userId] ?? []).filter((row) => row.harness !== body.harness),
      { harness: body.harness, credentialId: body.credentialId, model: body.model },
    ];
    return json({ ok: true });
  }
  if (route === "creds/accounts/auth-capabilities") {
    return json({ hostedOAuth: false, nativeCLI: { codex_auth: "armada creds login codex" } });
  }
  if (route === "creds/accounts/models") return json({ connections: [] });
  if (route === "creds/accounts/usage") return json({ error: { message: "Unknown route." } }, 404);
  const scope = body.scope === "org" ? "org" : body.scope === "user" ? "user" : null;
  if (!scope) return controlFail(400, "invalid", "Scope is user or org.");
  if (scope === "org" && !isAdmin(body.org, userId))
    return controlFail(403, "forbidden", "Only an org admin can do that.");
  const owner = scope === "org" ? body.org : userId;
  if (route === "creds/set" || route === "creds/rm") return singleton(route, body, scope, String(owner));
  const mine = (row: Row) => row.scope === scope && row.owner_id === owner && model(row) && row.status !== "deleted";
  const target = body.id === undefined ? undefined : state.credentials.find((row) => row.id === body.id && mine(row));
  if (body.id !== undefined && !target) return controlFail(404, "not_found", "No such account.");
  // As #603's store: only a rotation (`set` with an id) is versioned, and it must name the version it replaces.
  if (route === "creds/accounts/set" && target && typeof body.expectedVersion !== "number")
    return controlFail(400, "invalid", "expectedVersion is required to rotate an account.");
  const stale = route === "creds/accounts/set" && target && body.expectedVersion !== target.version;
  if (stale) return controlFail(409, "conflict", "This account changed.");
  const now = new Date().toISOString();
  if (route === "creds/accounts/set") {
    if (!(String(body.kind) in MODEL_KINDS)) return controlFail(400, "invalid", "Unknown kind.");
    const sealed = `\\x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`;
    if (target) {
      Object.assign(target, {
        value_enc: sealed,
        version: Number(target.version) + 1,
        updated_at: now,
        status: "active",
      });
      return json({ account: accountDto(target) });
    }
    const row: Row = {
      id: crypto.randomUUID(),
      scope,
      owner_id: owner,
      kind: body.kind,
      value_enc: sealed,
      created_at: now,
      name: String(body.name),
      is_default: false,
      version: 1,
      status: "active",
      expires_at: null,
      updated_at: now,
    };
    state.credentials.push(row);
    return json({ account: accountDto(row) });
  }
  if (!target) return controlFail(400, "invalid", "Name the account.");
  if (route === "creds/accounts/rename") {
    Object.assign(target, { name: String(body.name), updated_at: now });
    return json({ account: accountDto(target) });
  }
  if (route === "creds/accounts/default") {
    const harness = MODEL_KINDS[String(target.kind)];
    // As #603: every same-harness row of the owner, tombstones included, so a removed default stops blocking.
    for (const row of state.credentials.filter(
      (item) =>
        item.scope === scope && item.owner_id === owner && model(item) && MODEL_KINDS[String(item.kind)] === harness,
    ))
      row.is_default = row === target;
    return json({ account: accountDto(target) });
  }
  if (route === "creds/accounts/remove") {
    // A tombstone, never a deleted row: historical sandbox bindings keep their billing identity.
    // It keeps `is_default`: a removed default blocks implicit resolution until another default is chosen.
    Object.assign(target, { status: "deleted", updated_at: now });
    return json({ account: accountDto(target) });
  }
  return json({ error: "Not found." }, 404);
}

function control(url: URL, body: Row): Response {
  if (url.pathname === "/__test/reset") {
    state = seed();
    pendingOAuth.clear();
    sessions.clear();
    goldenJobs.clear();
    return json({ ok: true });
  }
  if (url.pathname === "/__test/capabilities") {
    const provider = body.provider === "modal" ? "modal" : "boat";
    state.capabilities[provider].maxGoldens = body.maxGoldens === null ? null : Number(body.maxGoldens ?? 1);
    return json({ ok: true });
  }
  if (url.pathname === "/__test/accounts") {
    for (const row of (body.seed as Row[] | undefined) ?? []) state.credentials.push(row);
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
  if (url.pathname === "/__test/github-connections") {
    return json(state.github_connections.map((row) => ({ ...row })));
  }
  if (url.pathname === "/__test/state") {
    return json({ launches: state.launches });
  }
  return json({ message: "not found" }, 404);
}

function langfuseControl(request: Request, match: RegExpMatchArray, body: Row): Response {
  const org = match[1]!;
  const testing = Boolean(match[2]);
  const user = viewer(request);
  if (!user) return json({ error: "unauthorized" }, 401);
  const admin = isAdmin(org, user);
  if (!isMember(org, user) || (!admin && (testing || request.method !== "GET"))) {
    return json({ error: "forbidden" }, 403);
  }
  const saved = state.langfuse.get(org);
  const status = { enabled: saved?.enabled ?? false, contentMode: saved?.contentMode ?? "metadata" };
  const host = "https://cloud.langfuse.com";
  if (request.method === "GET" && !testing) {
    if (!admin) return json(status);
    return json({
      ...status,
      configured: Boolean(saved),
      host: saved?.host ?? host,
      publicKey: saved?.publicKey ?? null,
      counters: { exported: 0, failed: 0, dropped: 0 },
      lastExportAt: null,
    });
  }
  if (request.method === "DELETE" && !testing) {
    state.langfuse.delete(org);
    return new Response(null, { status: 204 });
  }
  if ((testing && request.method !== "POST") || (!testing && request.method !== "PUT")) {
    return new Response(null, { status: 405 });
  }
  const candidate: Row = { host, ...status, ...saved, ...body };
  if (!candidate.publicKey || !candidate.secretKey) return json({ error: "langfuse_configuration_unavailable" }, 400);
  if (testing) {
    return json({
      status:
        candidate.host !== host
          ? "unreachable"
          : candidate.publicKey === "fixture_public" && candidate.secretKey === "fixture_secret"
            ? "ok"
            : "rejected",
    });
  }
  state.langfuse.set(org, candidate);
  return json({ enabled: candidate.enabled, contentMode: candidate.contentMode });
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (Buffer.byteLength(url.pathname + url.search, "utf8") > MAX_REQUEST_TARGET_BYTES)
      return new Response("Bad Request", { status: 400 });
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.method !== "DELETE";
    if (url.pathname.startsWith("/rest/v1/")) return rest(request, url);
    const text = hasBody ? await request.text() : "";
    const body = text ? (JSON.parse(text) as Row) : {};
    if (url.pathname.startsWith("/auth/v1/")) return auth(request, url, body);
    if (url.pathname.startsWith("/__test/")) return control(url, body);
    if (url.pathname === "/mcp") return mcp(body as unknown as RpcMessage, viewer(request));
    const canonicalLaunch = url.pathname === "/api/v1/sandbox/launch";
    if (
      request.method === "POST" &&
      (url.pathname === "/api/v1/sandbox/launch-access-v1" || (canonicalLaunch && body.armadaAccess))
    ) {
      if (
        body.armadaAccessVersion !== 1 ||
        body.harness !== "codex" ||
        !body.credentialId ||
        JSON.stringify(body.armadaAccess) !== JSON.stringify({ maxActiveChildren: 3 })
      )
        return controlFail(
          400,
          "invalid",
          "Armada access requires an explicit Codex account and bounded child access.",
        );
      return launchRoute(body, viewer(request));
    }
    if (url.pathname === "/api/v1/sandbox/launch-sized-v1" && request.method === "POST") {
      // #653's fail-closed route (ea501bd): an older replica does not know it, a newer one checks the version first.
      // Either refusal comes before anything is allocated.
      if (body.sizePolicyVersion !== 1)
        return controlFail(400, "invalid", "The sized launch route requires sizePolicyVersion 1.");
      return launchRoute(body, viewer(request));
    }
    if (canonicalLaunch && request.method === "POST") return launchRoute(body, viewer(request));
    if (url.pathname.startsWith("/api/v1/mcp/") && request.method === "POST") {
      return mcpControl(url.pathname.slice("/api/v1/mcp/".length), body, viewer(request));
    }
    if (url.pathname.startsWith("/oauth/")) return oauth(url);
    const langfuse = url.pathname.match(/^\/api\/v1\/orgs\/([0-9a-f-]{36})\/langfuse(\/test)?$/i);
    if (langfuse) return langfuseControl(request, langfuse, body);
    if (url.pathname.startsWith("/api/v1/")) {
      const route = url.pathname.slice("/api/v1/".length);
      if (route === "docker/hosts/list" && body.org === LARGE) {
        const caller = viewer(request);
        if (!caller || !isMember(body.org, caller))
          return controlFail(403, "forbidden", "Only organization members can list hosts.");
        return json({ placement: true, hosts: largeHosts() });
      }
      if (route === "docker/snapshots/list" && body.org === LARGE) {
        const caller = viewer(request);
        if (!caller || !isMember(body.org, caller))
          return controlFail(403, "forbidden", "Only organization members can list snapshots.");
        return json({ snapshots: largeHostSnapshots() });
      }
      if (route === "launch/options" && isMember(LARGE, viewer(request) ?? "")) {
        if (!viewer(request)) return controlFail(401, "unauthorized", "Sign in again.");
        return json({
          providers: [
            {
              id: "docker",
              enabled: true,
              launchSources: ["image", "golden"],
              harnesses: ["claude", "codex"],
              capabilities: {
                launch: true,
                followupPrompts: true,
                stop: true,
                delete: true,
                status: true,
                logs: true,
                goldens: true,
              },
              unsupportedReasons: {},
            },
          ],
        });
      }
      if (route === "auth/email/start") return json({ ok: true });
      if (route === "skillpack/catalog" || route === "skillpack/versions")
        return skillCatalogRoute(route, body, request);
      if (route === "golden/build/status") return goldenJobStatus(body, request);
      if (route === "golden/build/find") return findGoldenJob(body, request);
      if (route === "golden/build/cancel") return cancelGoldenJob(body, request);
      if (route === "golden/create" || route === "golden/update") return goldenBuild(route, body, request);
      if (route === "golden/capabilities") return goldenCapabilities(body, request);
      if (route === "golden/remove") return goldenRemove(body, request);
      if (route === "golden/size-policy") return goldenSizePolicy(body, request);
      if (route === "org/provider/status" || route === "org/provider/connect" || route === "org/provider/disconnect")
        return orgProvider(route, body, request);
      if (
        route === "creds/list" ||
        route === "creds/defaults/set" ||
        route === "creds/set" ||
        route === "creds/rm" ||
        route.startsWith("creds/accounts/")
      )
        return accounts(route, body, request);
      if (route === "sandbox/test-model-connection") {
        const userId = viewer(request);
        if (!userId) return controlFail(401, "unauthorized", "Sign in again.");
        const machine = state.sandboxes.find((row) => row.id === body.id);
        if (!machine || machine.owner_id !== userId)
          return controlFail(403, "forbidden", "Only the sandbox owner may test.");
        const account = state.credentials.find((row) => row.id === machine.credential_id);
        if (
          !(machine.provider === "modal" || (machine.provider === "boat" && machine.boat_runtime === true)) ||
          !["ready", "running"].includes(String(machine.status)) ||
          machine.stop_requested_at != null ||
          !account ||
          account.status !== "active" ||
          account.version !== machine.credential_version
        )
          return controlFail(409, "conflict", "The bound sandbox/account is not ready.");
        // No live credentials: fixed native-wire outcomes prove UI transport/rendering only.
        return json({
          id: body.id,
          test:
            body.model === "missing-deployment"
              ? { ok: false, status: 404, error: "provider_rejected", code: "model_not_found" }
              : { ok: true, status: 200, error: null, code: null },
        });
      }
      if (route === "sandbox/bind-credential") return bindCredential(body, viewer(request));
      if (route.startsWith("variables/") || route.startsWith("secrets/")) return vaultRoute(route, body, request);
      if (route.startsWith("routines/")) return routineRoute(route, body, request);
      if (route.startsWith("templates/")) return templateRoute(route, body, request);
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

// Isolated infrastructure stand-ins only: SQL, Boat HTTP and pinned SSH.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { createServiceToken, createSqlAuthStore } from "@armada/auth";
import * as core from "@armada/core/server";
import { applyMigrations, openDatabase } from "../../../../scripts/db/apply.ts";
import { run } from "../../../cli/src/run.ts";
import { memorySessionStore } from "../../../cli/src/session.ts";
import { checkSandboxSkillLaunch } from "./sandbox-skill-launch.ts";
import { catalogLock, catalogReceipt, catalogReference } from "./skillpack-catalog.ts";

const db = await openDatabase();
await applyMigrations(db);
const sql: core.Sql = {
  query: (q, v) => db.query(q, v),
  transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
};
const sqlModule = await import("../../src/sql.ts");
mock.module(new URL("../../src/sql.ts", import.meta.url).pathname, () => ({ ...sqlModule, bunSql: () => sql }));
const boots = new Map<string, string>();
const sshCalls: string[] = [];
mock.module("@armada/core/server", () => ({
  ...core,
  sshStdinCheckout: async () => {},
  sshOrchestratorReceipt: async (_provider: unknown, input: { sandboxId: string; token: string }) => {
    const payload = JSON.parse(input.token);
    sshCalls.push(payload.op ?? "bridge");
    return {
      physicalGeneration: boots.get(input.sandboxId),
      acknowledged: true,
      port: 32100,
      epoch: String(payload.epoch ?? "1"),
      authorityInstalled: payload.op !== "scrub",
    };
  },
}));
const key = Buffer.alloc(32, 17).toString("base64");
const ownerId = crypto.randomUUID(),
  orgId = crypto.randomUUID();
await sql.query("insert into auth.users(id) values($1)", [ownerId]);
await sql.query("insert into orgs(id,name) values($1,'Boat serve fixture')", [orgId]);
await sql.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [orgId, ownerId]);
await sql.query(
  "insert into credentials(scope,owner_id,kind,value_enc,name) values('user',$1,'boat',$2,'Boat fixture')",
  [ownerId, await core.encryptSecret("synthetic-boat-key", key)],
);
const models = new Map<string, string>();
for (const [harness, kind] of [
  ["codex", "openai"],
  ["claude", "anthropic"],
]) {
  const id = crypto.randomUUID();
  models.set(harness!, id);
  await sql.query("insert into credentials(id,scope,owner_id,kind,value_enc,name) values($1,'user',$2,$3,$4,$5)", [
    id,
    ownerId,
    kind,
    await core.encryptSecret(`synthetic-${kind}-key`, key),
    `Model ${harness}`,
  ]);
}
const goldens = core.createSqlGoldenStore(sql);
const golden = await goldens.insert({
  orgId,
  ownerId,
  name: "Boat HTTP source",
  visibility: "private",
  provider: "boat",
  modal: null,
  config: { repos: [{ url: "https://github.com/example/fixture.git", branch: "main", dir: "fixture" }], init: [] },
});
await goldens.setSnapshot(golden.id, "boat-source");
const nativeFetch = globalThis.fetch;
const realFetch = nativeFetch.bind(globalThis);
type Machine = {
  id: string;
  name: string;
  state: string;
  createdAt: string;
  archiveAfter: string;
  labels: Record<string, string>;
  desktopAvailable: boolean;
  snapshotAvailable: boolean;
  model?: string;
  harness?: string;
  conversation?: string;
  events: {
    id: string;
    timestamp: number;
    type: string;
    conversationId: string;
    taskId: string;
    data: Record<string, unknown>;
  }[];
};
const machines = new Map<string, Machine>();
let prompts = 0,
  stops = 0,
  failStop = false;
const requests: string[] = [];
const skillLaunchOrder: string[] = [];
let eventReads = 0;
let observedPoll: (() => void) | undefined;
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  assert.equal(url.origin, "https://boat.dev", "Unexpected outbound network");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  const path = url.pathname;
  requests.push(`${method} ${path}`);
  const json = (value: unknown, status = 200) => Response.json({ ok: true, ...(value as object) }, { status });
  if (path === "/api/v1/sandboxes" && method === "POST") {
    const id = `bx_${crypto.randomUUID()}`;
    const machine: Machine = {
      id,
      name: id,
      state: "running",
      createdAt: new Date().toISOString(),
      archiveAfter: new Date(Date.now() + 86400000).toISOString(),
      labels: body.labels ?? {},
      desktopAvailable: false,
      snapshotAvailable: false,
      events: [],
    };
    machines.set(id, machine);
    boots.set(id, crypto.randomUUID());
    return json({ sandbox: machine }, 202);
  }
  const match = path.match(/^\/api\/v1\/sandboxes\/([^/]+)(.*)$/);
  if (!match) throw Error(`Unexpected Boat route ${method} ${path}`);
  const machine = machines.get(decodeURIComponent(match[1]!));
  assert(machine, `Unknown Boat sandbox ${path}`);
  const suffix = match[2];
  if (!suffix) return json({ sandbox: machine });
  if (suffix === "/commands") {
    if (JSON.stringify(body).includes("git rev-parse --git-path info/exclude")) skillLaunchOrder.push("exclude");
    if (JSON.stringify(body).includes("skillpack install")) skillLaunchOrder.push("install");
    return json({
      type: "command.finished",
      success: true,
      exitCode: JSON.stringify(body).includes("example/missing") ? 1 : 0,
      stdout: catalogLock(JSON.stringify(body).includes("claude-code") ? "claude-code" : "codex"),
      stderr: "",
      timedOut: false,
    });
  }
  if (suffix === "/prompt") {
    skillLaunchOrder.push("prompt");
    prompts++;
    machine.model = body.model;
    machine.harness = body.provider === "codex" ? "codex" : "claude";
    const conversationId = machine.conversation ?? `conv_${prompts}`;
    assert(!body.conversationId || body.conversationId === conversationId, "Conversation changed after activation");
    machine.conversation = conversationId;
    const timestamp = Date.now();
    machine.events.push(
      ...[
        {
          id: `queued-${prompts}`,
          timestamp,
          type: "prompt",
          conversationId,
          taskId: `prompt-${prompts}`,
          data: { status: "queued", prompt: body.prompt },
        },
        {
          id: `running-${prompts}`,
          timestamp: timestamp + 1,
          type: "prompt",
          conversationId,
          taskId: `prompt-${prompts}`,
          data: { status: "running", prompt: body.prompt },
        },
        {
          id: `reply-${prompts}`,
          timestamp: timestamp + 2,
          type: "response",
          conversationId,
          taskId: `prompt-${prompts}`,
          data: { content: `reply ${prompts}`, is_streaming: false },
        },
        {
          id: `finished-${prompts}`,
          timestamp: timestamp + 3,
          type: "prompt",
          conversationId,
          taskId: `prompt-${prompts}`,
          data: { status: "finished", prompt: body.prompt },
        },
      ],
    );
    return json({ promptId: `prompt-${prompts}`, conversationId, status: "queued" }, 202);
  }
  if (suffix === "/steer")
    return Response.json({ ok: false, code: "no_running_turn", message: "Nothing runs" }, { status: 409 });
  if (suffix.startsWith("/prompts/"))
    return json({
      promptRun: {
        promptId: suffix.split("/").at(-1),
        conversationId: machine.conversation,
        status: "finished",
        done: true,
      },
    });
  if (suffix === "/events") {
    eventReads++;
    observedPoll?.();
    const cursor = url.searchParams.get("cursor");
    const anchor = cursor ? Buffer.from(cursor, "base64url").toString("utf8") : null;
    const start = anchor ? machine.events.findIndex((event) => `${event.timestamp}:${event.id}` === anchor) + 1 : 0;
    assert(!anchor || start > 0, "Cursor must belong to this sandbox history");
    assert(!url.searchParams.get("conversation") || url.searchParams.get("conversation") === machine.conversation);
    return json({ events: machine.events.slice(start), pageInfo: { hasMore: false } });
  }
  if (suffix === "/conversations")
    return json({
      conversations: machine.conversation
        ? [{ id: machine.conversation, running: false, lastHarness: machine.harness, lastModel: machine.model }]
        : [],
    });
  if (suffix === "/interrupt") return json({});
  if (suffix === "/stop") {
    stops++;
    if (failStop) {
      failStop = false;
      machine.state = "archived";
      machine.events.push({
        id: `tail-${stops}`,
        timestamp: (machine.events.at(-1)?.timestamp ?? 0) + 1,
        type: "response",
        conversationId: machine.conversation!,
        taskId: `prompt-${prompts}`,
        data: { content: "unread archival tail", is_streaming: false },
      });
      return json({ code: "invalid_request", message: "synthetic ambiguity" }, 400);
    }
    machine.state = "archived";
    return json({ id: machine.id, stop: { id: `stop-${stops}`, status: "completed" } }, 202);
  }
  if (suffix.startsWith("/stops/"))
    return json({ id: machine.id, stop: { id: decodeURIComponent(suffix.split("/").at(-1)!), status: "completed" } });
  if (suffix === "/resume") {
    machine.state = "running";
    boots.set(machine.id, crypto.randomUUID());
    return json({ sandbox: machine }, 202);
  }
  throw Error(`Unexpected Boat route ${method} ${path}`);
}) as typeof fetch;
globalThis.fetch = fakeFetch;
const { startServer } = await import("../../src/serve.ts");
const token = await createServiceToken(createSqlAuthStore(sql), {
  userId: ownerId,
  label: "Boat fixture",
  now: new Date(),
});
const logs: string[] = [];
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port;
await probe.stop(true);
const server = await startServer(
  {
    PORT: String(port),
    ARMADA_DATABASE_URL: "postgres://fixture.invalid/db",
    SUPABASE_URL: "https://supabase.invalid",
    SUPABASE_ANON_KEY: "fixture-anon",
    ARMADA_AUTH_SECRET: "synthetic-auth-secret",
    ARMADA_PUBLIC_URL: "https://serve.invalid",
    ARMADA_ENCRYPTION_KEY: key,
    ARMADA_ORCHESTRATOR_PAIRS: "boat:claude,boat:codex",
    ARMADA_ORCHESTRATOR_SKILL_REVISION: "a".repeat(40),
  },
  { log: (line) => logs.push(line), logError: (line) => logs.push(line) },
);
const origin = `http://127.0.0.1:${server.port}`;
async function cli(args: string[], expected = 0) {
  let out = "",
    err = "";
  const auth = {
    env: { ARMADA_URL: origin, ARMADA_TOKEN: token.token },
    session: memorySessionStore(),
    now: () => new Date(),
    open: () => {},
    fetch: fakeFetch,
    out: (value: string) => {
      out += value;
    },
    err: (value: string) => {
      err += value;
    },
  };
  const code = await run(["orchestrator", ...args, "--json"], auth, { auth });
  assert.equal(code, expected, `${args.join(" ")}: ${err}\n${out}\n${logs.join("\n")}\n${requests.join("\n")}`);
  return JSON.parse(out || err);
}
try {
  for (const harness of ["codex", "claude"] as const) {
    const model = core.resolveModelChoice(harness, {}).model;
    const create = await cli([
      "create",
      `Boat ${harness}`,
      "--skill",
      catalogReference,
      "--org",
      orgId,
      "--golden",
      golden.id,
      "--provider",
      "boat",
      "--agent",
      harness,
      "--model",
      model,
      "--model-account",
      models.get(harness)!,
      "--idempotency-key",
      `create-${harness}`,
    ]);
    const id = create.orchestratorId;
    let detail: core.OrchestratorDetail = await cli(["detail", id, "--org", orgId]);
    for (let i = 0; i < 150; i++) {
      detail = await cli(["detail", id, "--org", orgId]);
      if (detail?.orchestrator.state !== "creating") break;
    }
    assert(detail);
    assert.equal(detail.orchestrator.state, "ready", JSON.stringify({ detail, logs, requests }));
    assert.equal(detail.orchestrator.configuration.skill, catalogReference);
    assert.deepEqual(detail.orchestrator.skillReceipt, catalogReceipt);
    let revision = detail.orchestrator.revision;
    const act = async (action: string, text?: string, expected = 0) => {
      const result = await cli(
        [
          action,
          id,
          ...(text ? [text] : []),
          "--org",
          orgId,
          "--expected-revision",
          String(revision),
          "--idempotency-key",
          `${harness}-${action}-${revision}`,
        ],
        expected,
      );
      if (result.revision) revision = result.revision;
      return result;
    };
    const readsBeforeSend = eventReads;
    await act("send", "hello");
    // No owner events request yet: only the production background consumer can
    // pull this page and publish its cursor/activity. Await I/O, never a sleep.
    if (eventReads === readsBeforeSend)
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(Error("Managed Boat event consumer never polled")), 10000);
        observedPoll = () => {
          clearTimeout(deadline);
          observedPoll = undefined;
          resolve();
        };
      });
    let journal: { provider_cursor: string | null; count: number } | undefined;
    for (let attempts = 0; attempts < 1000; attempts++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      journal = (
        await sql.query<{ provider_cursor: string | null; count: number }>(
          `select provider_cursor,(select count(*)::int from public.orchestrator_activity where orchestrator_id=$1) as count
         from public.orchestrator_runtime where orchestrator_id=$1`,
          [id],
        )
      ).rows[0];
      if (journal?.provider_cursor && journal.count > 0) break;
    }
    assert(
      journal?.provider_cursor && journal.count > 0,
      `Background pull must publish activity and cursor before owner reads ${JSON.stringify({ journal, logs, requests })}`,
    );
    const receipt = (
      await sql.query<{ runtime_result: { kind: string; promptId: string } }>(
        `select runtime_result from public.orchestrator_operations where orchestrator_id=$1 and action='message' order by revision desc limit 1`,
        [id],
      )
    ).rows[0]?.runtime_result;
    assert.equal(receipt?.kind, "prompt_receipt");
    assert.equal(receipt.promptId, `prompt-${prompts}`);
    assert.equal(prompts, harness === "codex" ? 1 : 4, "Owner send must dispatch to Boat");
    const page: core.OrchestratorEventPage = await cli(["events", id, "--org", orgId, "--all"]);
    const agentEvents = page.events
      .filter((item: core.OrchestratorEvent) => item.kind === "agent")
      .map((item: core.OrchestratorEvent) => (item.kind === "agent" ? item.event : undefined));
    assert(
      agentEvents.some((item) => item?.kind === "prompt" && item.status === "queued"),
      JSON.stringify(page),
    );
    assert(
      agentEvents.some((item) => item?.kind === "message" && item.text === `reply ${prompts}`),
      JSON.stringify(page),
    );
    assert(
      agentEvents.some((item) => item?.kind === "prompt" && item.status === "finished"),
      JSON.stringify(page),
    );
    const steerRevision = revision;
    const refused = await act("steer", "too late", 1);
    assert.equal(refused.state, "failed", JSON.stringify(refused));
    assert.equal(refused.errorCode, "no_running_turn");
    detail = await cli(["detail", id, "--org", orgId]);
    assert.equal(detail.orchestrator.state, "ready");
    assert.equal(detail.orchestrator.blockedReason, null);
    const conversationId = detail.orchestrator.conversationId;
    const steerDispatches = requests.filter((request) => request.endsWith("/steer")).length;
    await act("send", "new turn");
    detail = await cli(["detail", id, "--org", orgId]);
    assert.equal(detail.orchestrator.conversationId, conversationId);
    assert.equal(detail.orchestrator.state, "ready");
    const replayedSteer = await cli(
      [
        "steer",
        id,
        "too late",
        "--org",
        orgId,
        "--expected-revision",
        String(steerRevision),
        "--idempotency-key",
        `${harness}-steer-${steerRevision}`,
      ],
      1,
    );
    assert.deepEqual(replayedSteer, refused);
    assert.equal(requests.filter((request) => request.endsWith("/steer")).length, steerDispatches);
    await act("stop");
    detail = await cli(["detail", id, "--org", orgId]);
    assert.equal(detail.orchestrator.state, "stopped");
    await act("resume");
    detail = await cli(["detail", id, "--org", orgId]);
    assert.equal(detail.orchestrator.state, "ready");
    assert.equal(detail.orchestrator.continuity, "unverified", JSON.stringify(detail));
    await act("send", "continue");
    const continued: core.OrchestratorEventPage = await cli([
      "events",
      id,
      "--org",
      orgId,
      "--cursor",
      page.cursor ?? "",
      "--all",
    ]);
    assert(
      continued.events.some(
        (item) => item.kind === "agent" && item.event.kind === "message" && item.event.text === `reply ${prompts}`,
      ),
      JSON.stringify(continued),
    );
    failStop = true;
    await act("stop", undefined, 1);
    detail = await cli(["detail", id, "--org", orgId]);
    assert.equal(detail.orchestrator.state, "blocked");
    const retirementRevision = revision;
    const recovered = await act("recover");
    const retired: core.OrchestratorEventPage = await cli(["events", id, "--org", orgId, "--all"]);
    assert(
      retired.events.some(
        (item) => item.kind === "agent" && item.event.kind === "message" && item.event.text === "unread archival tail",
      ),
      JSON.stringify(retired),
    );
    const physicalStops = stops;
    const replay = await cli([
      "recover",
      id,
      "--org",
      orgId,
      "--expected-revision",
      String(retirementRevision),
      "--idempotency-key",
      `${harness}-recover-${retirementRevision}`,
    ]);
    assert.equal(replay.id, recovered.id);
    assert.equal(stops, physicalStops, "Completed retirement replay must not issue provider I/O");
    detail = await cli(["detail", id, "--org", orgId]);
    assert.equal(detail.orchestrator.state, "stopped");
  }
  const beforeFailurePrompts = prompts;
  const failed = await cli([
    "create",
    "missing method",
    "--org",
    orgId,
    "--golden",
    golden.id,
    "--provider",
    "boat",
    "--agent",
    "codex",
    "--model",
    core.resolveModelChoice("codex", {}).model,
    "--model-account",
    models.get("codex")!,
    "--skill",
    "example/missing@1.0.0",
    "--idempotency-key",
    "missing-method",
  ]);
  let blocked: core.OrchestratorDetail = await cli(["detail", failed.orchestratorId, "--org", orgId]);
  for (let i = 0; i < 150 && blocked.orchestrator.state === "creating"; i++)
    blocked = await cli(["detail", failed.orchestratorId, "--org", orgId]);
  assert.equal(blocked.orchestrator.state, "blocked");
  assert.equal(blocked.orchestrator.skillReceipt, null);
  assert.equal(blocked.orchestrator.conversationId, null);
  assert.equal(prompts, beforeFailurePrompts, "Failed installation must not start a turn");
  assert(logs.some((line) => line.includes('"kind":"prompt_dispatch"') && line.includes('"value":"accepted"')));
  assert(logs.some((line) => line.includes('"kind":"prompt_status"') && line.includes('"value":"finished"')));
  assert(logs.some((line) => line.includes('"kind":"events_poll"') && line.includes('"value":"published"')));
  assert(!logs.some((line) => line.includes('stage="native_checkpoint"')), logs.join("\n"));
  const baselinePrompts = prompts,
    baselineStops = stops;
  await checkSandboxSkillLaunch({
    sql,
    orgId,
    body: {
      golden: golden.name,
      org: orgId,
      provider: "boat",
      harness: "codex",
      credentialId: models.get("codex"),
      connections: [],
    },
    allocations: () => machines.size,
    prompts: () => prompts,
    stops: () => stops,
    order: skillLaunchOrder,
    request: async (action, body) => {
      const response = await fakeFetch(`${origin}/api/v1/sandbox/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  });
  assert.equal(prompts - baselinePrompts, 1);
  assert.equal(stops - baselineStops, 2);
  console.log(
    `SERVE_BOAT_RECEIPT ${JSON.stringify({ prompts, stops, sshCalls: sshCalls.length, sandboxSkills: true })}`,
  );
} finally {
  await server.stop(true);
  await server.workerDone;
  await db.close();
}

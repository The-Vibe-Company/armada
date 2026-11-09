/**
 * The orchestrator routes of #647's v1 contract (`/api/v1/orchestrators`), as the browser tests need them: owner-only
 * visibility, revision fences, idempotent receipts and an event cursor. A stand-in for presentation tests only; the
 * real policy, persistence and runtime belong to the server producers and their own tests, not to this mock.
 */

type Row = Record<string, unknown>;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ALICE = id(1);
const BOB = id(2);
const ACME = id(10);
export const ORCHESTRATOR_IDS = { alice: id(160), bob: id(161) };

type Orchestrator = Row & { id: string; ownerId: string; revision: number; state: string; continuity: string };
type Event = Row & { id: string; orchestratorId: string };

type OrchestratorState = {
  enabled: boolean;
  orchestrators: Orchestrator[];
  events: Event[];
  receipts: Map<string, { digest: string; receipt: Row }>;
  /** Every mutation as the dashboard sent it: route, body, key and whether it carried a session. */
  calls: { route: string; body: Row; key: string | null; authorized: boolean }[];
  /** The next mutation answers this, once (a lost answer is a 503 the dashboard must retry with the same key). */
  failNext: { status: number; code: string; message: string } | null;
  /** Feed reads fail while set: the browser must show it is reconnecting, then catch up from its cursor. */
  offline: boolean;
  sequence: number;
};

const at = (minute: number) => new Date(Date.UTC(2026, 10, 9, 10, minute)).toISOString();

let state = seed();

function orchestrator(oid: string, owner: string, name: string, extra: Row = {}): Orchestrator {
  return {
    version: 1,
    id: oid,
    ownerId: owner,
    configuration: {
      version: 1,
      orgId: ACME,
      name,
      goldenId: id(20),
      provider: "boat",
      harness: "claude",
      model: "claude-opus-5-5",
      reasoningEffort: "high",
      modelAccountId: "acct-claude",
      idleSeconds: 7200,
    },
    state: "ready",
    revision: 3,
    sandboxId: id(170),
    conversationId: "conv-1",
    continuity: "native",
    createdAt: at(0),
    updatedAt: at(5),
    lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    idleDeadline: new Date(Date.now() + 115 * 60_000).toISOString(),
    skillRevision: "9f47264e4c3a9a098906162815a2f1b4949030ba",
    blockedReason: null,
    ...extra,
  };
}

function seed(): OrchestratorState {
  const next: OrchestratorState = {
    enabled: true,
    orchestrators: [
      orchestrator(ORCHESTRATOR_IDS.alice, ALICE, "Release coordinator"),
      orchestrator(ORCHESTRATOR_IDS.bob, BOB, "Bob's private plan"),
    ],
    events: [],
    receipts: new Map(),
    calls: [],
    failNext: null,
    offline: false,
    sequence: 0,
  };
  const oid = ORCHESTRATOR_IDS.alice;
  const agent = (event: Row) => ({
    kind: "agent",
    event: { at: Date.parse(at(1)), conversationId: "conv-1", ...event },
  });
  for (const event of [
    agent({
      id: "a1",
      kind: "prompt",
      promptId: "p1",
      text: "Ship issues #12 and #13, one worker each.",
      status: "finished",
    }),
    agent({
      id: "a2",
      kind: "message",
      promptId: "p1",
      messageId: "m1",
      textMode: "snapshot",
      text: "Launched two workers. I will wait for their CI.",
      partial: false,
      tools: [
        {
          id: "t1",
          name: "sandbox_launch",
          input: { golden: "shared-golden" },
          result: { output: "ok", isError: false },
        },
      ],
    }),
    { kind: "child", sandboxId: id(30), operationId: "op-c1" },
  ])
    push(next, oid, event);
  return next;
}

function push(target: OrchestratorState, oid: string, event: Row): void {
  target.sequence += 1;
  const row = target.orchestrators.find((item) => item.id === oid);
  target.events.push({
    id: `ev-${target.sequence}`,
    orchestratorId: oid,
    at: new Date().toISOString(),
    revision: row?.revision ?? 0,
    ...event,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

function detail(row: Orchestrator): Row {
  const child = state.events.filter((event) => event.orchestratorId === row.id && event.kind === "child");
  return {
    version: 1,
    orchestrator: row,
    operations: [],
    waits:
      row.id === ORCHESTRATOR_IDS.alice && row.state === "ready"
        ? [
            {
              id: "w1",
              orchestratorId: row.id,
              kind: "ci",
              reference: "acme/web#12",
              reason: "CI of #12",
              expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(),
              deadline: new Date(Date.now() + 20 * 3_600_000).toISOString(),
            },
          ]
        : [],
    delegation: {
      id: "d1",
      orchestratorId: row.id,
      ownerId: row.ownerId,
      orgId: ACME,
      scopes: ["worker:launch", "worker:read", "worker:message", "worker:stop"],
      // A bounded epoch grant: at most 24 hours (ORCHESTRATOR_DEFAULTS.delegationSeconds).
      expiresAt: new Date(Date.now() + 20 * 3_600_000).toISOString(),
      revokedAt: null,
      childPolicy: "owned_children",
    },
    childSandboxIds: child.map((event) => event.sandboxId),
  };
}

/** Test controls: `/__test/orchestrators/{reset|disable|fail-next|offline|online|bump|patch|agent-reply|state}`. */
export function orchestratorTestControl(action: string, body: Row): Response {
  if (action === "reset") state = seed();
  else if (action === "disable") state.enabled = false;
  else if (action === "fail-next") state.failNext = body as OrchestratorState["failNext"];
  else if (action === "offline") state.offline = true;
  else if (action === "online") state.offline = false;
  else if (action === "bump") {
    // Someone else (the CLI, another tab) changed it: the page's revision is now stale.
    const row = state.orchestrators.find((item) => item.id === body.id);
    if (row) row.revision += 1;
  } else if (action === "patch") {
    const row = state.orchestrators.find((item) => item.id === body.id);
    if (row) Object.assign(row, body.patch);
  } else if (action === "agent-reply") {
    push(state, String(body.id), {
      kind: "agent",
      event: {
        id: `r-${state.sequence}`,
        at: Date.now(),
        kind: "message",
        conversationId: "conv-1",
        text: String(body.text),
        partial: false,
        tools: [],
      },
    });
  } else if (action !== "state") return json({ message: "not found" }, 404);
  return json({ calls: state.calls, orchestrators: state.orchestrators });
}

/** `creds/list` with named accounts (#603's additive fields): what the create form offers. */
export function credsList(userId: string | null): Response {
  if (!userId) return fail(401, "unauthorized", "Unauthorized.");
  return json({
    user: [
      {
        id: "acct-claude",
        name: "Alice Max",
        kind: "claude_oauth",
        status: "active",
        isDefault: true,
        createdAt: at(0),
      },
    ],
    orgs: [
      {
        id: ACME,
        name: "Acme",
        role: "admin",
        credentials: [{ id: "acct-codex", name: "Team Codex", kind: "openai", createdAt: at(0) }],
      },
    ],
  });
}

export function orchestratorRoute(request: Request, url: URL, body: Row, userId: string | null): Response {
  if (!state.enabled) {
    // What the server answers today, without the routes: GET is refused, POST is an unknown route.
    return request.method === "GET" ? fail(405, "invalid", "Use POST.") : fail(404, "not_found", "Unknown route.");
  }
  if (!userId) return fail(401, "unauthorized", "Unauthorized.");
  const parts = url.pathname.slice("/api/v1/orchestrators".length).split("/").filter(Boolean);
  if (request.method === "GET" && parts.length === 0) {
    const orgId = url.searchParams.get("orgId");
    const items = state.orchestrators.filter(
      (row) => row.ownerId === userId && (row.configuration as Row).orgId === orgId,
    );
    return json({ version: 1, items, cursor: null });
  }
  const row = parts[0] ? state.orchestrators.find((item) => item.id === parts[0]) : undefined;
  if (parts.length > 0 && (!row || row.ownerId !== userId)) return fail(404, "not_found", "No such orchestrator.");
  if (request.method === "GET" && row && parts.length === 1) return json(detail(row));
  if (request.method === "GET" && row && parts[1] === "events") {
    if (state.offline) return fail(503, "unavailable", "Armada is temporarily unavailable.");
    const after = Number(url.searchParams.get("cursor") ?? "0");
    const events = state.events.filter((event) => event.orchestratorId === row.id);
    const page = events.slice(after, after + 100);
    return json({
      version: 1,
      events: page,
      cursor: String(after + page.length),
      hasMore: after + page.length < events.length,
    });
  }
  if (request.method !== "POST") return fail(405, "invalid", "Use GET.");
  const key = request.headers.get("idempotency-key");
  const route = parts.length === 0 ? "create" : (parts[1] ?? "");
  state.calls.push({ route, body, key, authorized: true });
  if (!key) return fail(400, "invalid_request", "Idempotency-Key is required.");
  const target = row?.id ?? "create";
  const receiptKey = `${userId}|${route}|${target}|${key}`;
  const digest = JSON.stringify(body);
  const seen = state.receipts.get(receiptKey);
  if (seen)
    return seen.digest === digest
      ? json(seen.receipt, 202)
      : fail(409, "idempotency_conflict", "That key was used for another request.");
  const lost = state.failNext;
  state.failNext = null;
  if (lost && lost.status !== 503) return fail(lost.status, lost.code, lost.message);
  if (route === "create") {
    const created = orchestrator(id(180 + state.orchestrators.length), userId, String(body.name), {
      configuration: { ...body },
      revision: 1,
      continuity: "not_started",
      conversationId: null,
      lastActivityAt: new Date().toISOString(),
    });
    state.orchestrators.push(created);
    const answer = receipt(created, "create");
    state.receipts.set(receiptKey, { digest, receipt: answer });
    // Applied, then the answer was lost: a retry with the same key must return this receipt.
    return lost ? fail(lost.status, lost.code, lost.message) : json(answer, 202);
  }
  if (!row || !["message", "steer", "stop", "resume"].includes(route)) return fail(404, "not_found", "Unknown route.");
  if (body.expectedRevision !== row.revision)
    return fail(409, "stale_revision", `Revision ${String(body.expectedRevision)} is stale.`);
  apply(row, route, body);
  const answer = receipt(row, route);
  state.receipts.set(receiptKey, { digest, receipt: answer });
  return lost ? fail(lost.status, lost.code, lost.message) : json(answer, 202);
}

function receipt(row: Orchestrator, kind: string): Row {
  state.sequence += 1;
  return {
    version: 1,
    id: `op-${state.sequence}`,
    orchestratorId: row.id,
    kind,
    state: "succeeded",
    revision: row.revision,
    errorCode: null,
  };
}

function apply(row: Orchestrator, route: string, body: Row): void {
  row.revision += 1;
  row.updatedAt = new Date().toISOString();
  if (route === "message" || route === "steer") {
    row.lastActivityAt = row.updatedAt;
    row.continuity = "native";
    const promptId = `p-${state.sequence + 1}`;
    push(state, row.id, {
      kind: "agent",
      event:
        route === "message"
          ? {
              id: `u-${state.sequence}`,
              at: Date.now(),
              kind: "prompt",
              promptId,
              conversationId: "conv-1",
              text: body.text,
              status: "finished",
            }
          : { id: `s-${state.sequence}`, at: Date.now(), kind: "steer", conversationId: "conv-1", text: body.text },
    });
  }
  if (route === "stop") row.state = "stopped";
  if (route === "resume") row.state = "ready";
  if (route === "stop" || route === "resume")
    push(state, row.id, { kind: "state", state: row.state, continuity: row.continuity });
}

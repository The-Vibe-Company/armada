import { expect, test } from "bun:test";
import { MODEL_CATALOG, ORCHESTRATOR_DEFAULTS, type OrchestratorDetail } from "@armada/core";
import { createOrchestratorApi, failureOf, OrchestratorApiError } from "../src/lib/orchestrator-api.ts";
import {
  attemptFor,
  type CreateFields,
  childrenOf,
  idleChoices,
  type ModelAccount,
  OrchestratorContractError,
  orchestratorControls,
  orchestratorCreateRequest,
  parseModelAccounts,
  parseOrchestratorDetail,
  parseOrchestratorEventPage,
  parseOrchestratorList,
  unsettledAfter,
} from "../src/lib/orchestrators.ts";

const ORG = "00000000-0000-4000-8000-000000000010";
const ID = "00000000-0000-4000-8000-0000000000a1";
const TOKEN = "session-token-under-test";

function orchestrator(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: ID,
    ownerId: "00000000-0000-4000-8000-000000000001",
    configuration: {
      version: 1,
      orgId: ORG,
      name: "Release coordinator",
      goldenId: "00000000-0000-4000-8000-000000000020",
      provider: "boat",
      harness: "claude",
      model: "claude-opus-5-5",
      reasoningEffort: "high",
      modelAccountId: "acct-1",
      idleSeconds: 7200,
    },
    state: "ready",
    revision: 4,
    sandboxId: "00000000-0000-4000-8000-000000000030",
    conversationId: "conv-1",
    continuity: "native",
    createdAt: "2026-11-09T10:00:00.000Z",
    updatedAt: "2026-11-09T10:05:00.000Z",
    lastActivityAt: "2026-11-09T10:05:00.000Z",
    idleDeadline: "2026-11-09T12:05:00.000Z",
    skillRevision: "9f47264e4c3a9a098906162815a2f1b4949030ba",
    blockedReason: null,
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): OrchestratorDetail {
  return parseOrchestratorDetail(
    {
      version: 1,
      orchestrator: orchestrator(overrides),
      operations: [],
      waits: [],
      delegation: null,
      childSandboxIds: [],
      ...extra,
    },
    ID,
  );
}

test("a list keeps only well-formed orchestrators of the selected org and counts the unreadable", () => {
  const list = parseOrchestratorList(
    {
      version: 1,
      items: [
        orchestrator(),
        orchestrator({ id: "other-org", configuration: { ...orchestrator().configuration, orgId: "another" } }),
        orchestrator({ id: "bad", state: "exploded" }),
      ],
      cursor: null,
    },
    ORG,
  );
  expect(list.items.map((item) => item.id)).toEqual([ID]);
  expect(list.unreadable).toBe(1);
});

test("another contract version is refused, never read as v1", () => {
  expect(() => parseOrchestratorList({ version: 2, items: [], cursor: null }, ORG)).toThrow(OrchestratorContractError);
  expect(() => detail({ version: 2 })).toThrow(OrchestratorContractError);
});

test("events of another orchestrator are dropped and unknown kinds are kept for the technical view", () => {
  const page = parseOrchestratorEventPage(
    {
      version: 1,
      events: [
        {
          id: "e1",
          orchestratorId: ID,
          at: "2026-11-09T10:00:00.000Z",
          revision: 1,
          kind: "agent",
          event: { id: "a1", at: 1, kind: "message", text: "On it.", partial: false, tools: [] },
        },
        { id: "e2", orchestratorId: "someone-else", at: "2026-11-09T10:00:01.000Z", revision: 1, kind: "child" },
        { id: "e3", orchestratorId: ID, at: "2026-11-09T10:00:02.000Z", revision: 2, kind: "checkpoint" },
        {
          id: "e4",
          orchestratorId: ID,
          at: "2026-11-09T10:00:03.000Z",
          revision: 2,
          kind: "child",
          sandboxId: "child-1",
          operationId: "op-1",
        },
      ],
      cursor: "c2",
      hasMore: false,
    },
    ID,
  );
  expect(page.events.map((event) => event.kind)).toEqual(["agent", "unknown", "child"]);
  expect(page.cursor).toBe("c2");
  expect(childrenOf(detail({}, { childSandboxIds: ["child-0"] }), page.events)).toEqual(["child-0", "child-1"]);
});

test("controls follow state, the running turn, pending operations and continuity", () => {
  expect(orchestratorControls(detail(), false).can).toEqual({ message: true, steer: false, stop: true, resume: false });
  expect(orchestratorControls(detail(), true).can.steer).toBe(true);
  const stopped = orchestratorControls(detail({ state: "stopped" }), false);
  expect(stopped.can).toEqual({ message: false, steer: false, stop: false, resume: true });
  expect(stopped.composerNote).toContain("Resume");
  const pending = orchestratorControls(
    detail(
      {},
      {
        operations: [
          { version: 1, id: "op", orchestratorId: ID, kind: "stop", state: "pending", revision: 5, errorCode: null },
        ],
      },
    ),
    false,
  );
  expect(pending.can.message).toBe(false);
  expect(pending.can.stop).toBe(false);
  expect(pending.pending).toBe("stop");
});

test("a lost conversation is never offered as resumable and says to start a new orchestrator", () => {
  const lost = orchestratorControls(detail({ state: "stopped", continuity: "lost" }), false);
  expect(lost.can.resume).toBe(false);
  expect(lost.can.message).toBe(false);
  expect(lost.notice?.tone).toBe("danger");
  expect(lost.notice?.text).toContain("new orchestrator");
  const blocked = orchestratorControls(detail({ state: "blocked", blockedReason: "Checkpoint not confirmed." }), false);
  expect(blocked.notice?.text).toBe("Checkpoint not confirmed.");
  expect(blocked.can.stop).toBe(true);
});

const ACCOUNTS: ModelAccount[] = [
  { id: "acct-1", name: "Team Claude", harness: "claude", scope: "org", isDefault: true },
  { id: "acct-2", name: "My Codex", harness: "codex", scope: "user", isDefault: false },
];

function fields(overrides: Partial<CreateFields> = {}): CreateFields {
  return {
    org: ORG,
    name: " Release coordinator ",
    golden: "g1",
    provider: "boat",
    harness: "claude",
    model: "",
    otherModel: "",
    reasoningEffort: "",
    account: "acct-1",
    repo: "",
    idleSeconds: String(ORCHESTRATOR_DEFAULTS.idleSeconds),
    ...overrides,
  };
}

const OFFERED = { provider: "boat", repositories: ["web", "api"], accounts: ACCOUNTS };

test("create builds the v1 request with the catalog's defaults and omits limits the person left alone", () => {
  const request = orchestratorCreateRequest(fields(), OFFERED);
  expect(request).toEqual({
    ok: true,
    value: {
      version: 1,
      orgId: ORG,
      name: "Release coordinator",
      goldenId: "g1",
      provider: "boat",
      harness: "claude",
      model: MODEL_CATALOG.claude.defaultModel,
      reasoningEffort: MODEL_CATALOG.claude.defaultReasoningEffort,
      modelAccountId: "acct-1",
    },
  });
  const custom = orchestratorCreateRequest(fields({ repo: "api", idleSeconds: "900" }), OFFERED);
  expect(custom.ok && custom.value).toMatchObject({ repo: "api", idleSeconds: 900 });
  expect(custom.ok && "maxChildStartsPerDay" in custom.value).toBe(false);
  // No concurrency cap is implied: the provisional default is never filled in or sent.
  expect(custom.ok && "maxActiveChildren" in custom.value).toBe(false);
});

test("create refuses an account of the other harness, an unknown repository and an idle period out of bounds", () => {
  expect(orchestratorCreateRequest(fields({ account: "acct-2" }), OFFERED)).toEqual({
    ok: false,
    error: "Choose a Claude model account.",
  });
  expect(orchestratorCreateRequest(fields({ repo: "../etc" }), OFFERED).ok).toBe(false);
  expect(orchestratorCreateRequest(fields({ idleSeconds: "60" }), OFFERED).ok).toBe(false);
  expect(orchestratorCreateRequest(fields({ idleSeconds: "86401" }), OFFERED).ok).toBe(false);
  expect(orchestratorCreateRequest(fields({ provider: "modal" }), OFFERED).ok).toBe(false);
});

test("the idle choices stay within the server's bounds and mark its default", () => {
  const choices = idleChoices();
  expect(choices[0]?.seconds).toBe(ORCHESTRATOR_DEFAULTS.minIdleSeconds);
  expect(choices.at(-1)?.seconds).toBe(ORCHESTRATOR_DEFAULTS.maxIdleSeconds);
  expect(choices.find((choice) => choice.label.includes("default"))?.seconds).toBe(ORCHESTRATOR_DEFAULTS.idleSeconds);
});

test("model accounts are the named, active ones of the viewer and the selected org only", () => {
  const now = Date.parse("2026-11-09T12:00:00.000Z");
  const accounts = parseModelAccounts(
    {
      user: [
        { kind: "anthropic", createdAt: null },
        { id: "u1", name: "Mine", kind: "claude_oauth", status: "active", isDefault: true },
        { id: "u2", name: "Old", kind: "openai", expiresAt: "2026-11-01T00:00:00.000Z" },
        { id: "u3", name: "Gone", kind: "codex_auth", status: "revoked" },
      ],
      orgs: [
        {
          id: ORG,
          credentials: [
            { id: "o1", name: "Team", kind: "openai" },
            { kind: "boat", createdAt: null },
          ],
        },
        { id: "another", credentials: [{ id: "x1", name: "Elsewhere", kind: "anthropic" }] },
      ],
    },
    ORG,
    now,
  );
  expect(accounts).toEqual([
    { id: "u1", name: "Mine", harness: "claude", scope: "user", isDefault: true },
    { id: "o1", name: "Team", harness: "codex", scope: "org", isDefault: false },
  ]);
});

function client(answer: (request: Request) => Response, seen: Request[] = []) {
  return createOrchestratorApi({
    serverUrl: "https://armada.test/mcp",
    token: TOKEN,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request);
      return answer(request);
    }) as typeof fetch,
  });
}

test("a command posts the fence and text with the idempotency key and the bearer to the orchestrator route", async () => {
  const seen: Request[] = [];
  const api = client(
    () =>
      Response.json(
        { version: 1, id: "op-9", orchestratorId: ID, kind: "message", state: "pending", revision: 5, errorCode: null },
        { status: 202 },
      ),
    seen,
  );
  const receipt = await api.command(ID, "message", 4, "key-1", "Ship #12");
  expect(receipt.id).toBe("op-9");
  expect(seen[0]?.url).toBe(`https://armada.test/api/v1/orchestrators/${ID}/message`);
  expect(seen[0]?.headers.get("idempotency-key")).toBe("key-1");
  expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(await seen[0]?.json()).toEqual({ expectedRevision: 4, text: "Ship #12" });
  await api.command(ID, "stop", 5, "key-2");
  expect(await seen[1]?.json()).toEqual({ expectedRevision: 5 });
});

test("a server without orchestrator routes reads as unavailable, for GET and POST alike", async () => {
  const get = client(() => Response.json({ error: { code: "invalid", message: "Use POST." } }, { status: 405 }));
  const post = client(() =>
    Response.json({ error: { code: "not_found", message: "Unknown route." } }, { status: 404 }),
  );
  const listed = await get.list(ORG).catch((error: unknown) => error);
  const created = await post.command(ID, "resume", 1, "k").catch((error: unknown) => error);
  for (const error of [listed, created]) {
    expect(error).toBeInstanceOf(OrchestratorApiError);
    expect((error as OrchestratorApiError).failure).toBe("unavailable");
  }
});

test("failures say whether the same request may be sent again, and never carry the token", async () => {
  expect(failureOf(409, { error: { code: "stale_revision", message: "Revision 3 is stale." } }).failure).toBe("stale");
  expect(failureOf(409, { error: { code: "no_native_continuity", message: "No native conversation." } }).message).toBe(
    "No native conversation.",
  );
  expect(failureOf(401, null).failure).toBe("session");
  expect(failureOf(429, { error: { code: "limit", message: "Too many active orchestrators." } }).failure).toBe(
    "rejected",
  );
  expect(failureOf(503, null).retrySameKey).toBe(true);
  expect(failureOf(409, { error: { code: "stale_revision", message: "x" } }).retrySameKey).toBe(false);
  const lost = await client(() => {
    throw new TypeError(`fetch failed ${TOKEN}`);
  })
    .command(ID, "message", 1, "k", "hi")
    .catch((error: unknown) => error as OrchestratorApiError);
  expect(lost.failure).toBe("uncertain");
  expect(lost.message).not.toContain(TOKEN);
});

test("after an unknown outcome the same request is repeated with its original revision and key", () => {
  let keys = 0;
  const newKey = () => `k${++keys}`;
  const first = attemptFor(null, "message", "Ship #12", 4, newKey);
  const unsettled = unsettledAfter(first, { ok: false, failure: "uncertain" });
  // The page has since read revision 5 (perhaps the message's own effect): the retry still sends revision 4, key k1.
  expect(attemptFor(unsettled, "message", "Ship #12", 5, newKey)).toEqual(first);
  expect(attemptFor(unsettled, "message", "Ship #13", 5, newKey)).toEqual({
    command: "message",
    text: "Ship #13",
    expectedRevision: 5,
    key: "k2",
  });
  expect(unsettledAfter(first, { ok: false, failure: "stale" })).toBeNull();
  expect(unsettledAfter(first, { ok: true })).toBeNull();
});

test("a configuration carrying the withdrawn daily start quota is still read, and the quota is not kept", () => {
  const read = detail({ configuration: { ...orchestrator().configuration, maxChildStartsPerDay: 10 } });
  expect(read.orchestrator.configuration).not.toHaveProperty("maxChildStartsPerDay");
  expect(read.orchestrator.configuration.idleSeconds).toBe(7200);
});

test("a worker limit is read only when the owner set one; its absence never becomes the provisional default", () => {
  expect(detail().orchestrator.configuration).not.toHaveProperty("maxActiveChildren");
  const chosen = detail({ configuration: { ...orchestrator().configuration, maxActiveChildren: 2 } });
  expect(chosen.orchestrator.configuration.maxActiveChildren).toBe(2);
});

import { expect, spyOn, test } from "bun:test";
import type { AgentEvent, Sql } from "@armada/core";
import { decryptSecret, encryptSecret } from "@armada/core/server";
import { AuthUnavailable } from "../src/caller.ts";
import { createJobsRunner, type JobStore } from "../src/jobs/runner.ts";
import { createJobsStore, JOBS_WAKE } from "../src/jobs/store.ts";
import { createLangfuse, upsertLangfusePrLinkedScores } from "../src/langfuse.ts";
import {
  langfusePrLinkedScore,
  langfuseSpans,
  langfuseTurnScores,
  resolveLangfuseContext,
} from "../src/langfuse-spans.ts";
import { runtimeWakes } from "../src/wake-bus.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";

const database = rowOnlyDatabase();
async function runExport(
  db: Sql,
  exporter: ReturnType<typeof createLangfuse>,
  signal = new AbortController().signal,
  store: JobStore = createJobsStore(db),
) {
  const errors: string[] = [];
  const runner = createJobsRunner(store, { langfuse_export: exporter.exportJob }, (line) => errors.push(line));
  const claimed = await runner.reconcileOne(signal);
  await runner.drain();
  runner.stopAdmission();
  expect(errors).toEqual([]);
  return claimed;
}

const key = Buffer.alloc(32, 1).toString("base64");
const encryptConfig = () =>
  encryptSecret(
    JSON.stringify({ host: "https://langfuse.test", publicKey: "public_placeholder", secretKey: "secret_placeholder" }),
    key,
  );

const events: AgentEvent[] = [
  { id: "start", at: 1000, promptId: "turn", kind: "prompt", status: "running", text: "customer_prompt" },
  {
    id: "message",
    at: 1100,
    promptId: "turn",
    kind: "message",
    partial: false,
    text: "customer_reply",
    tools: [
      { id: "tool", name: "exec", input: "customer_argument", result: { isError: true, output: "customer_result" } },
    ],
  },
  {
    id: "end",
    at: 1200,
    promptId: "turn",
    kind: "prompt",
    status: "failed",
    text: "customer_prompt",
    reason: "customer_failure",
  },
];
test("completed turns use stable OTLP identities, durations and opt-in content", () => {
  const queued: AgentEvent = {
    kind: "prompt",
    id: "queued",
    at: 900,
    promptId: "turn",
    status: "queued",
    text: "customer_prompt",
  };
  const metadata = langfuseSpans("sandbox", [queued, ...events], [], false);
  expect(metadata).toHaveLength(2);
  expect(metadata[0]).toMatchObject({
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: "1200000000",
    status: { code: 2 },
  });
  expect(metadata[1]?.parentSpanId).toBe(metadata[0]?.spanId);
  expect(JSON.stringify(metadata)).not.toContain("customer_");
  const full = langfuseSpans("sandbox", events, [], true);
  expect(full.map(({ traceId, spanId }) => ({ traceId, spanId }))).toEqual(
    metadata.map(({ traceId, spanId }) => ({ traceId, spanId })),
  );
  for (const text of ["customer_prompt", "customer_reply", "customer_argument", "customer_result", "customer_failure"])
    expect(JSON.stringify(full)).toContain(text);
});
test("each turn has its own trace and timing within the sandbox session", () => {
  const secondTurn = events.map((event) => ({ ...event, promptId: "second-turn", at: event.at + 10_000 }));
  const spans = langfuseSpans("sandbox", [...events, ...secondTurn], [], false);
  const roots = spans.filter((span) => !span.parentSpanId);
  expect(roots.map(({ startTimeUnixNano, endTimeUnixNano }) => [startTimeUnixNano, endTimeUnixNano])).toEqual([
    ["1000000000", "1200000000"],
    ["11000000000", "11200000000"],
  ]);
  expect(new Set(roots.map((root) => root.traceId)).size).toBe(2);
  for (const root of roots) {
    const trace = spans.filter((span) => span.traceId === root.traceId);
    expect(trace).toHaveLength(2);
    expect(trace[1]?.parentSpanId).toBe(root.spanId);
    for (const span of trace)
      expect(span.attributes).toContainEqual({ key: "langfuse.session.id", value: { stringValue: "sandbox" } });
  }
});
test("a prompt event with an unknown status never becomes an exported span", () => {
  const forged = { ...events[0]!, id: "forged", status: "customer_status" } as unknown as AgentEvent;
  const spans = langfuseSpans("sandbox", [...events, forged], [], false, { contentWithheld: "secret" });
  expect(spans).toHaveLength(2);
  expect(JSON.stringify(spans)).not.toContain("customer_");
});
test("tool results retain the invoked tool identity and input", () => {
  const result: AgentEvent = {
    id: "result",
    at: 1150,
    promptId: "turn",
    kind: "message",
    responseKind: "tool_result",
    text: "",
    partial: false,
    tools: [{ id: "tool", name: "tool_result", result: { output: "customer_result", isError: true } }],
  };
  const spans = langfuseSpans("sandbox", [events[0]!, events[1]!, result, events[2]!], [], true);
  expect(spans[1]).toMatchObject({ name: "exec", status: { code: 2 }, endTimeUnixNano: "1150000000" });
  expect(JSON.stringify(spans[1])).toContain("customer_argument");
});
function settingsRequest(orgId: string, method: string, input?: object, suffix = "") {
  return new Request(`https://armada.test/api/v1/orgs/${orgId}/langfuse${suffix}`, {
    method,
    body: input === undefined ? undefined : JSON.stringify(input),
  });
}

test("partial Langfuse settings updates preserve encrypted keys and disconnect clears the configuration", async () => {
  const { db, people } = await database();
  const route = createLangfuse(db, key).route(async () => ({
    ok: true,
    caller: { userId: people.admin, via: "service", orgs: [{ orgId: people.org, role: "admin" }] },
  }));
  const put = (input: object) => route(settingsRequest(people.org, "PUT", input));
  const read = async () => (await route(settingsRequest(people.org, "GET")))!.json();
  expect((await put({ enabled: true }))?.status).toBe(400);
  const created = await put({ enabled: true, publicKey: "public_placeholder", secretKey: "secret_placeholder" });
  expect(await created?.json()).toEqual({ enabled: true, contentMode: "metadata" });

  expect((await put({ enabled: false }))?.status).toBe(200);
  expect((await put({ contentMode: "full", publicKey: "new_public" }))?.status).toBe(200);
  const config = (
    await db.query<{ config_enc: Uint8Array<ArrayBuffer> }>("select config_enc from org_langfuse where org_id=$1", [
      people.org,
    ])
  ).rows[0]!;
  expect(JSON.parse(await decryptSecret(config.config_enc, key))).toEqual({
    host: "https://cloud.langfuse.com",
    publicKey: "new_public",
    secretKey: "secret_placeholder",
  });
  expect(await read()).toEqual({
    enabled: false,
    contentMode: "full",
    host: "https://cloud.langfuse.com",
    publicKey: "new_public",
    configured: true,
    counters: { exported: 0, failed: 0, dropped: 0 },
    lastExportAt: null,
  });
  expect((await put({ host: "https://different.test" }))?.status).toBe(400);
  expect((await route(settingsRequest(people.org, "DELETE")))?.status).toBe(204);
  expect(await read()).toMatchObject({ enabled: false, contentMode: "metadata", configured: false, publicKey: null });
});

test("a complete Langfuse replacement can recover unreadable stored credentials", async () => {
  const { db, people } = await database();
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'full',$2)", [
    people.org,
    new Uint8Array([1]),
  ]);
  const route = createLangfuse(db, key).route(async () => ({
    ok: true,
    caller: { userId: people.admin, via: "service", orgs: [{ orgId: people.org, role: "admin" }] },
  }));
  const replaced = await route(
    settingsRequest(people.org, "PUT", {
      host: "https://replacement.test",
      publicKey: "replacement_public",
      secretKey: "replacement_secret",
    }),
  );
  expect(await replaced?.json()).toEqual({ enabled: true, contentMode: "full" });
  expect(await (await route(settingsRequest(people.org, "GET")))?.json()).toMatchObject({
    configured: true,
    host: "https://replacement.test",
    publicKey: "replacement_public",
  });
});

test("only the organization's admins can change or test settings and members can read status alone", async () => {
  const { db, people } = await database();
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'full',$2)", [
    people.org,
    await encryptConfig(),
  ]);
  const route = createLangfuse(db, key).route(async () => ({
    ok: true,
    caller: {
      userId: people.member,
      via: "service",
      orgs: [
        { orgId: people.org, role: "member" },
        { orgId: people.otherOrg, role: "admin" },
      ],
    },
  }));
  expect(await (await route(settingsRequest(people.org, "GET")))?.json()).toEqual({
    enabled: true,
    contentMode: "full",
  });
  expect((await route(settingsRequest(people.org, "PUT", { enabled: false })))?.status).toBe(403);
  expect((await route(settingsRequest(people.org, "DELETE")))?.status).toBe(403);
  expect((await route(settingsRequest(people.org, "POST", {}, "/test")))?.status).toBe(403);
  expect((await route(settingsRequest(crypto.randomUUID(), "GET")))?.status).toBe(403);
});

test("the Langfuse connection test checks keys without exporting a trace or persisting candidates", async () => {
  const { db, people } = await database();
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,false,'metadata',$2)", [
    people.org,
    await encryptConfig(),
  ]);
  const attempts: { url: string; init: RequestInit | undefined }[] = [];
  let upstream = 200;
  const route = createLangfuse(db, key, (async (url, init) => {
    attempts.push({ url: String(url), init });
    init?.signal?.throwIfAborted();
    return new Response("upstream_body", { status: upstream });
  }) as typeof fetch).route(async () => ({
    ok: true,
    caller: { userId: people.admin, via: "service", orgs: [{ orgId: people.org, role: "admin" }] },
  }));
  const probe = (input?: object) => route(settingsRequest(people.org, "POST", input, "/test"));
  expect(await (await probe())?.json()).toEqual({ status: "ok" });
  expect(attempts[0]?.url).toBe("https://langfuse.test/api/public/projects");
  expect(attempts[0]?.init).toMatchObject({
    method: "GET",
    redirect: "error",
    signal: expect.any(AbortSignal),
    headers: { authorization: `Basic ${Buffer.from("public_placeholder:secret_placeholder").toString("base64")}` },
  });
  expect(attempts[0]?.init?.body).toBeUndefined();

  expect(await (await probe({ secretKey: "candidate_secret" }))?.json()).toEqual({ status: "ok" });
  expect(new Headers(attempts[1]?.init?.headers).get("authorization")).toBe(
    `Basic ${Buffer.from("public_placeholder:candidate_secret").toString("base64")}`,
  );
  upstream = 401;
  expect(await (await probe({}))?.json()).toEqual({ status: "rejected" });
  expect(attempts[2]?.init?.headers).toEqual(attempts[0]?.init?.headers);

  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
    AbortSignal.abort(new DOMException("timeout", "TimeoutError")),
  );
  try {
    expect(await (await probe())?.json()).toEqual({ status: "unreachable" });
    expect(timeout.mock.calls).toEqual([[5000]]);
  } finally {
    timeout.mockRestore();
  }

  expect((await probe({ host: "http://langfuse.test" }))?.status).toBe(400);
  expect((await probe({ host: "https://different.test" }))?.status).toBe(400);
  expect(attempts).toHaveLength(4);
});

async function settledBoatTurn(prompt: string, mode: "metadata" | "full" = "full") {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,task_prompt_id)
     select $1,id,org_id,owner_id,'boat_export','codex','ready',$3
     from goldens where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner, prompt],
  );
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,$3,$2)", [
    people.org,
    await encryptConfig(),
    mode,
  ]);
  await db.query("select public.enqueue_webhook_turn($1,$2,'failed')", [id, prompt]);
  const counters = async () =>
    (
      await db.query<{ exported: string; failed: string }>(
        "select exported::text,failed::text from org_langfuse_export_stats where org_id=$1",
        [people.org],
      )
    ).rows;
  return { db, counters, org: people.org };
}

test("cutover transfers pending receipts and fences a legacy worker that already claimed one", async () => {
  const { db } = await settledBoatTurn("turn");
  const migration = await Bun.file(
    new URL("../../../supabase/migrations/20261119175832_langfuse_export_jobs.sql", import.meta.url),
  ).text();
  const lease = crypto.randomUUID();
  const leaseUntil = new Date("2050-01-01T00:00:00.000Z");
  await db.transaction(async (tx) => {
    await tx.exec("drop trigger queue_langfuse_export on langfuse_turn_exports; drop function queue_langfuse_export()");
    await tx.exec("delete from jobs");
    await tx.query(`update langfuse_turn_exports set attempts=5,lease_id=$1,lease_until=$2 where prompt_id='turn'`, [
      lease,
      leaseUntil,
    ]);
    await tx.exec(`
      select public.enqueue_webhook_turn(sandbox_id,'unclaimed','finished') from langfuse_turn_exports
      where prompt_id='turn';
      select public.enqueue_webhook_turn(sandbox_id,'already_sent','finished') from langfuse_turn_exports
      where prompt_id='turn';
      update langfuse_turn_exports set completed_at=now() where prompt_id='already_sent';
    `);
    await tx.exec(migration);
  });
  expect(
    (
      await db.query(
        "select outcome->>'promptId' as prompt,attempts,run_after=$1 as deferred from jobs order by prompt",
        [leaseUntil],
      )
    ).rows,
  ).toEqual([
    { prompt: "turn", attempts: 4, deferred: true },
    { prompt: "unclaimed", attempts: 0, deferred: false },
  ]);
  expect(
    (
      await db.query(
        "select prompt_id from langfuse_turn_exports where completed_at is null and (lease_until is null or lease_until<now())",
      )
    ).rows,
  ).toEqual([]);
  const legacyCompletion = await db.query(
    "update langfuse_turn_exports set completed_at=now() where prompt_id='turn' and lease_id=$1 returning org_id",
    [lease],
  );
  expect(legacyCompletion.rows).toEqual([]);
});

test("a settled receipt still exports metadata after historical history-only retries", async () => {
  const { db, counters } = await settledBoatTurn("turn");
  await db.query(
    `update jobs set attempts=5,outcome=outcome || '{"historyRetries":5}'::jsonb where kind='langfuse_export'`,
  );
  const exportReceipt = createLangfuse(
    db,
    key,
    (async (_url, _init) => new Response(null, { status: 200 })) as typeof fetch,
  );
  expect(await runExport(db, exportReceipt, new AbortController().signal)).toBe(true);
  expect(await counters()).toEqual([{ exported: "1", failed: "0" }]);
});

test.each(["full", "settled", "delivered", "tainted", "template"])("runtime OTLP export policy: %s", async (mode) => {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,boat_runtime,usage_turns)
    select $1,id,org_id,owner_id,'export_fixture','codex','ready',true,$3::jsonb from goldens where owner_id=$2 and visibility='private' limit 1`,
    [
      id,
      people.owner,
      JSON.stringify({
        turnCount: 1,
        turns: [
          { promptId: "turn", model: "model_placeholder", inputTokens: null, outputTokens: 0, cachedTokens: null },
        ],
      }),
    ],
  );
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,$3,$2)", [
    people.org,
    await encryptConfig(),
    mode === "settled" ? "metadata" : "full",
  ]);
  const archive: AgentEvent[] = [
    events[0]!,
    {
      id: "delta",
      at: 1050,
      promptId: "turn",
      kind: "message",
      messageId: "reply",
      textMode: "delta",
      partial: true,
      text: "Hel",
      tools: [],
    },
    {
      id: "snapshot",
      at: 1100,
      promptId: "turn",
      kind: "message",
      messageId: "reply",
      textMode: "snapshot",
      partial: false,
      text: "Hello",
      tools: [],
    },
    events[2]!,
  ];
  // An earlier turn larger than the per-export record bound must not consume this
  // turn's window; its undecryptable placeholder rows prove they are never read.
  await db.query(
    `insert into runtime_events(sandbox_id,sequence,epoch,counted_prompt_id,event_enc)
     select $1,n,1,case when n=1 then 'earlier' end,'\\x00'::bytea from generate_series(1,2001) n`,
    [id],
  );
  for (const [index, event] of archive.entries())
    await db.query(
      "insert into runtime_events(sandbox_id,sequence,epoch,counted_prompt_id,event_enc) values($1,$2,'1',$3,$4)",
      [id, index + 2002, index === 0 ? "turn" : null, await encryptSecret(JSON.stringify(event), key)],
    );
  await db.query("select public.enqueue_webhook_turn($1,'turn','failed')", [id]);
  if (mode === "delivered")
    await db.query("update org_langfuse set content_mode='metadata' where org_id=$1", [people.org]);
  if (mode === "tainted") await db.query("update sandboxes set application_secret_tainted=true where id=$1", [id]);
  if (mode === "settled") await db.query("update org_langfuse set content_mode='full' where org_id=$1", [people.org]);
  if (mode === "template") {
    await db.exec("set session_replication_role=replica");
    try {
      await db.query(
        `insert into template_launch_requests(org_id,actor_id,client_key,digest,template_id,revision_id,manifest,golden_operation_fence_id,sandbox_id,state)
         select org_id,owner_id,'fixture',repeat('a',64),gen_random_uuid(),gen_random_uuid(),
           '{"definition":{"secrets":[{"key":"APP"}]}}',gen_random_uuid(),id,'succeeded' from sandboxes where id=$1`,
        [id],
      );
    } finally {
      await db.exec("set session_replication_role=origin");
    }
  }
  const requests: Request[] = [];
  const exporter = createLangfuse(db, key, (async (url, init) => {
    requests.push(url instanceof Request ? new Request(url, init) : new Request(String(url), init));
    return new Response(null, { status: 200 });
  }) as typeof fetch);
  expect(await runExport(db, exporter, new AbortController().signal)).toBe(true);
  expect(requests[0]?.url).toBe("https://langfuse.test/api/public/otel/v1/traces");
  expect(requests[0]?.headers.get("x-langfuse-ingestion-version")).toBe("4");
  const body = (await requests[0]!.json()) as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] };
  const exportedSpans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
  const root = exportedSpans.find((s) => attr(s, "langfuse.observation.type") === "agent")!;
  const gen = exportedSpans.find((s) => attr(s, "langfuse.observation.type") === "generation")!;
  expect([
    gen.parentSpanId,
    attr(root, "langfuse.observation.output"),
    attr(gen, "langfuse.observation.usage_details"),
  ]).toEqual([root.spanId, mode === "full" ? "Hello" : undefined, '{"output":0}']);
  expect(attr(gen, "langfuse.observation.model.name")).toBe(
    mode === "tainted" || mode === "template" ? undefined : "model_placeholder",
  );
  if (mode === "tainted" || mode === "template") expect(attr(root, "langfuse.trace.name")).toBe("Armada sandbox");
});

type OtlpSpan = {
  spanId: string;
  parentSpanId?: string;
  name?: string;
  attributes: { key: string; value: { stringValue?: string; arrayValue?: { values: { stringValue: string }[] } } }[];
};
const attrVal = (span: OtlpSpan, name: string) => span.attributes.find((a) => a.key === name)?.value;
const attr = (span: OtlpSpan, name: string) => attrVal(span, name)?.stringValue;
const prFix = (repository: string, number: number, state: "open" | "merged" | "closed", headBranch: string) => ({
  repository,
  number,
  url: `https://github.com/${repository}/pull/${number}?secret=nope`,
  headBranch,
  state,
  checkedAt: "2026-11-25T10:00:00.000Z",
});

test("multi-model generations emit separate spans, filter default, include 5D tokens and TTFT", () => {
  const turnEvents: AgentEvent[] = [
    { id: "s", at: 1000, promptId: "p1", kind: "prompt", status: "running", text: "fix bug" },
    { id: "m1", at: 1250, promptId: "p1", kind: "message", partial: true, text: "work", model: "default", tools: [] },
    { id: "m2", at: 1400, promptId: "p1", kind: "message", partial: false, text: "done", tools: [] },
    { id: "e", at: 2000, promptId: "p1", kind: "prompt", status: "finished", text: "fix bug" },
  ];
  const pricing = {
    schemaVersion: 1 as const,
    basis: "estimated" as const,
    credentialId: null,
    credentialVersion: null,
    capturedAt: "2026-11-25T00:00:00.000Z",
    snapshot: null,
    inputs: null,
    usd: "0.0125",
    unknown: null,
  };
  const spans = langfuseSpans(
    "sb-1",
    turnEvents,
    [
      {
        promptId: "p1",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 40,
        cachedTokens: 20,
        cacheWriteTokens: 15,
        reasoningTokens: 10,
        pricing,
      },
      { promptId: "p1", model: "claude-haiku-4-5", inputTokens: 50, outputTokens: 10, cachedTokens: null },
      { promptId: "p1", model: "default", inputTokens: 5, outputTokens: 2, cachedTokens: null },
    ],
    false,
    {},
    {
      orgId: "org-1",
      ownerId: "user-1",
      provider: "modal",
      harness: "antigravity",
      requestedModel: "default",
      goldenName: "web-golden",
      templateName: "pr-fixer",
      externalRef: "GH-4331",
      pullRequests: [prFix("The-Vibe-Company/armada", 123, "open", "feat/lf")],
    },
  );
  const root = spans.find((s) => attr(s, "langfuse.observation.type") === "agent")!;
  const gens = spans.filter((s) => attr(s, "langfuse.observation.type") === "generation");
  expect(gens).toHaveLength(3);
  for (const s of spans) {
    expect([
      attr(s, "langfuse.trace.name"),
      attr(s, "langfuse.user.id"),
      attr(s, "langfuse.trace.metadata.pr_url"),
      attr(s, "langfuse.trace.metadata.ttft_ms"),
      attr(s, "langfuse.trace.metadata.requested_model"),
      attr(s, "langfuse.trace.metadata.executed_models"),
    ]).toEqual([
      "antigravity · The-Vibe-Company/armada #123",
      "user-1",
      "https://github.com/The-Vibe-Company/armada/pull/123",
      "250",
      undefined,
      '["claude-sonnet-4-6","claude-haiku-4-5"]',
    ]);
    expect(attr(s, "langfuse.release")).toBeTruthy();
    const tags = attrVal(s, "langfuse.trace.tags")?.arrayValue?.values.map((v) => v.stringValue) ?? [];
    expect(tags).toEqual(expect.arrayContaining(["harness:antigravity", "pr_linked", "template:pr-fixer"]));
    expect(tags).not.toContain("model:default");
  }
  const sonnet = gens.find((g) => g.name === "claude-sonnet-4-6")!;
  expect([
    sonnet.parentSpanId,
    attr(sonnet, "langfuse.observation.usage_details"),
    attr(sonnet, "langfuse.observation.cost_details"),
    attr(sonnet, "langfuse.observation.completion_start_time"),
    attr(gens.find((g) => g.name === "generation")!, "langfuse.observation.model.name"),
  ]).toEqual([
    root.spanId,
    '{"input":100,"output":40,"cache_read_input_tokens":20,"cache_creation_input_tokens":15,"reasoning":10}',
    '{"total":0.0125}',
    "1970-01-01T00:00:01.250Z",
    undefined,
  ]);
});

test("resolveLangfuseContext enforces PR precedence and contentWithheld isolation", () => {
  const ev: AgentEvent[] = [
    {
      id: "m",
      at: 1100,
      promptId: "t1",
      kind: "message",
      partial: false,
      text: "Opened https://github.com/org/ev-repo/pull/99?token=raw_secret#top",
      tools: [],
    },
  ];
  expect(
    resolveLangfuseContext(
      {
        pullRequests: [prFix("org/confirmed", 11, "merged", "fix/a")],
        taskOutcome: { state: "ready", prUrl: "https://github.com/org/outcome/pull/22", headSha: "abcdef1" },
      },
      ev,
      { promptId: "t1" },
    ),
  ).toMatchObject({
    prRepo: "org/confirmed",
    prNumber: 11,
    prUrl: "https://github.com/org/confirmed/pull/11",
    prState: "merged",
    branch: "fix/a",
    headSha: "abcdef1",
  });
  expect(
    resolveLangfuseContext(
      {
        pullRequestSource: {
          repositories: [{ url: "https://github.com/org/src-repo.git", dir: "app", branch: "main" }],
        },
        pullRequestReports: { "1:t1": { state: "ready", prNumber: 42, headSha: "1234567" } },
      },
      ev,
      { promptId: "t1" },
    ),
  ).toMatchObject({
    prRepo: "org/src-repo",
    prNumber: 42,
    prUrl: "https://github.com/org/src-repo/pull/42",
    branch: "main",
    headSha: "1234567",
  });
  expect(
    resolveLangfuseContext(
      {
        pullRequestSource: { repositories: [{ url: "https://github.com/org/src-repo.git", dir: "app" }] },
        taskOutcome: { state: "ready", prUrl: "https://gitlab.example/org/repo/pull/7", prNumber: 7 },
      },
      [
        {
          id: "m",
          at: 1100,
          promptId: "t1",
          kind: "message",
          partial: false,
          text: "Opened https://github.com/org/ev-repo/pull/99.",
          tools: [],
        },
      ],
      { promptId: "t1" },
    ),
  ).toMatchObject({ prRepo: "org/ev-repo", prNumber: 99, prUrl: "https://github.com/org/ev-repo/pull/99" });
  expect(
    resolveLangfuseContext(
      {
        taskOutcome: { state: "ready", prUrl: "https://github.com/org/leak/pull/88?s=1", headSha: "deadbeef" },
        pullRequestScan: { pushes: { "org/leak": [["secret-branch", ["deadbeef"]]] } },
        requestedModel: "secret-model",
      },
      ev,
      { promptId: "t1", contentWithheld: true },
    ),
  ).toEqual({});
});

test("tool spans emit mcp_server, duration_ms, ERROR level, and 32 KiB scrubbed truncation", () => {
  const big = "x".repeat(40_000);
  const bearer = `Bearer ${"tok".repeat(6)}`;
  const toolEvents: AgentEvent[] = [
    { id: "s", at: 1000, promptId: "t", kind: "prompt", status: "running", text: "y".repeat(70_000) },
    {
      id: "c",
      at: 1100,
      promptId: "t",
      kind: "message",
      partial: false,
      text: "call",
      tools: [{ id: "tc1", name: "read_issue", server: "github", input: `${bearer} ${big}` }],
    },
    {
      id: "r",
      at: 1350,
      promptId: "t",
      kind: "message",
      responseKind: "tool_result",
      partial: false,
      text: "",
      tools: [{ id: "tc1", name: "tool_result", result: { isError: true, output: `${big} ${bearer}` } }],
    },
    { id: "e", at: 1500, promptId: "t", kind: "prompt", status: "finished", text: "" },
  ];
  const spans = langfuseSpans("sb", toolEvents, [], true);
  const root = spans.find((s) => attr(s, "langfuse.observation.type") === "agent")!;
  const tool = spans.find((s) => attr(s, "langfuse.observation.type") === "tool")!;
  expect([
    attr(root, "langfuse.observation.level"),
    attr(root, "langfuse.observation.metadata.input_truncated"),
  ]).toEqual(["WARNING", "true"]);
  expect(Buffer.byteLength(attr(root, "langfuse.observation.input")!)).toBeLessThanOrEqual(64 * 1024);
  expect([
    attr(tool, "langfuse.observation.level"),
    attr(tool, "langfuse.observation.metadata.mcp_server"),
    attr(tool, "langfuse.observation.metadata.duration_ms"),
    attr(tool, "langfuse.observation.metadata.input_truncated"),
    attr(tool, "langfuse.observation.metadata.output_truncated"),
  ]).toEqual(["ERROR", "github", "250", "true", "true"]);
  expect(Buffer.byteLength(attr(tool, "langfuse.observation.input")!)).toBeLessThanOrEqual(32 * 1024);
  expect(Buffer.byteLength(attr(tool, "langfuse.observation.output")!)).toBeLessThanOrEqual(32 * 1024);
  expect(JSON.stringify(spans)).not.toContain("toktok");
  const withheldSpans = langfuseSpans("sb", toolEvents, [], true, {
    contentWithheld: "application_secret_bindings",
  });
  const withheldRoot = withheldSpans.find((s) => attr(s, "langfuse.observation.type") === "agent")!;
  const withheldTool = withheldSpans.find((s) => attr(s, "langfuse.observation.type") === "tool")!;
  expect([
    withheldTool.name,
    attr(withheldTool, "langfuse.observation.metadata.mcp_server"),
    attr(withheldTool, "langfuse.observation.input"),
    attr(withheldTool, "langfuse.observation.output"),
    attr(withheldRoot, "langfuse.observation.input"),
    attr(withheldRoot, "langfuse.observation.output"),
  ]).toEqual(["tool", undefined, undefined, undefined, undefined, undefined]);

  const noStartSpans = langfuseSpans(
    "sb",
    [toolEvents[1]!, toolEvents[3]!],
    [{ promptId: "t", model: "m", inputTokens: 1, outputTokens: 1, cachedTokens: null }],
    false,
  );
  const noStartGen = noStartSpans.find((s) => attr(s, "langfuse.observation.type") === "generation")!;
  expect(attr(noStartGen, "langfuse.observation.completion_start_time")).toBeUndefined();
  expect(langfuseTurnScores("sb", [toolEvents[1]!, toolEvents[3]!]).find((s) => s.name === "ttft_ms")).toBeUndefined();
});

test("langfuseTurnScores are deterministic and score delivery failures never fail export", async () => {
  const turnEvents: AgentEvent[] = [
    { id: "s", at: 1000, promptId: "turn", kind: "prompt", status: "running", text: "go" },
    {
      id: "m",
      at: 1120,
      promptId: "turn",
      kind: "message",
      partial: false,
      text: "done https://github.com/org/repo/pull/5",
      tools: [
        { id: "t1", name: "a", result: { isError: false, output: "ok" } },
        { id: "t2", name: "b", result: { isError: true, output: "err" } },
      ],
    },
    { id: "e", at: 1500, promptId: "turn", kind: "prompt", status: "finished", text: "go" },
  ];
  const scores = langfuseTurnScores("sb-score", turnEvents);
  expect(scores).toEqual(langfuseTurnScores("sb-score", turnEvents));
  expect(scores.map(({ name, value, dataType }) => ({ name, value, dataType }))).toEqual([
    { name: "turn_success", value: 1, dataType: "BOOLEAN" },
    { name: "tool_error_rate", value: 0.5, dataType: "NUMERIC" },
    { name: "ttft_ms", value: 120, dataType: "NUMERIC" },
    { name: "pr_linked", value: 1, dataType: "BOOLEAN" },
  ]);
  expect(scores.every((s) => /^[0-9a-f]{32}$/.test(s.id)) && new Set(scores.map((s) => s.id)).size === 4).toBe(true);

  const { db, counters } = await settledBoatTurn("turn");
  await db.query(`update sandboxes set external_ref='GH-4331', pull_requests=$1::jsonb where task_prompt_id='turn'`, [
    JSON.stringify([prFix("org/app", 7, "open", "feat/x")]),
  ]);
  const sent: { url: string; body: string }[] = [];
  const exporter = createLangfuse(db, key, (async (url, init) => {
    const href = String(url);
    sent.push({ url: href, body: String(init?.body ?? "") });
    return new Response(null, { status: href.endsWith("/scores") ? 500 : 200 });
  }) as typeof fetch);
  expect(await runExport(db, exporter, new AbortController().signal)).toBe(true);
  expect(sent[0]?.url).toBe("https://langfuse.test/api/public/otel/v1/traces");
  expect(sent[0]?.body).toContain("codex · org/app #7");
  expect(sent[0]?.body).toContain("GH-4331");
  expect(sent.slice(1).map((r) => [r.url, JSON.parse(r.body)])).toMatchObject([
    ["https://langfuse.test/api/public/scores", { name: "turn_success", value: 0, dataType: "BOOLEAN" }],
    ["https://langfuse.test/api/public/scores", { name: "pr_linked", value: 1, dataType: "BOOLEAN" }],
  ]);
  expect(await counters()).toEqual([{ exported: "1", failed: "0" }]);
});

test("usage_details exports disjoint buckets per harness without double counting", () => {
  const turnEvents: AgentEvent[] = [
    { id: "s", at: 1000, promptId: "p1", kind: "prompt", status: "running", text: "hi" },
    { id: "e", at: 1200, promptId: "p1", kind: "prompt", status: "finished", text: "hi" },
  ];
  const usageFor = (harness: string, row: Parameters<typeof langfuseSpans>[2][number]) =>
    JSON.parse(
      attr(
        langfuseSpans("sb", turnEvents, [row], false, {}, { harness }).find(
          (s) => attr(s, "langfuse.observation.type") === "generation",
        )!,
        "langfuse.observation.usage_details",
      )!,
    );
  const full = {
    promptId: "p1",
    model: "m1",
    inputTokens: 1000,
    outputTokens: 200,
    cachedTokens: 600,
    cacheWriteTokens: 100,
    reasoningTokens: 80,
  };
  const shared = { cache_read_input_tokens: 600, cache_creation_input_tokens: 100, reasoning: 80 };
  expect(usageFor("codex", full)).toEqual({ input: 300, output: 120, ...shared });
  expect(usageFor("claude", full)).toEqual({ input: 1000, output: 120, ...shared });
  expect(usageFor("opencode", full)).toEqual({ input: 1000, output: 120, ...shared });
  expect(usageFor("antigravity", full)).toEqual({ input: 1000, output: 200, ...shared });
  expect(
    usageFor("codex", { promptId: "p1", model: "m1", inputTokens: 300, outputTokens: 60, cachedTokens: 90 }),
  ).toEqual({ input: 210, output: 60, cache_read_input_tokens: 90 });
  expect(
    usageFor("codex", {
      promptId: "p1",
      model: "m1",
      inputTokens: 50,
      outputTokens: 10,
      cachedTokens: 80,
      reasoningTokens: 20,
    }),
  ).toEqual({ cache_read_input_tokens: 80, reasoning: 20 });
});

test("ACP tool updates preserve invoked tool names and skip empty tool-only frames in rootOut and TTFT", () => {
  const msg = (id: string, at: number, text: string, tools: Extract<AgentEvent, { kind: "message" }>["tools"]) =>
    ({
      id,
      at,
      promptId: "p1",
      kind: "message",
      partial: false,
      text,
      tools,
    }) satisfies AgentEvent;
  const acpEvents: AgentEvent[] = [
    { id: "s", at: 1000, promptId: "p1", kind: "prompt", status: "running", text: "check" },
    msg("t1-call", 1100, "", [{ id: "tc1", name: "run_command", input: { cmd: "ls" } }]),
    msg("t1-res", 1200, "", [{ id: "tc1", name: "tool_result", result: { isError: false, output: "ok" } }]),
    msg("t2-call", 1250, "", [{ id: "tc2", name: "read_file", input: { path: "a.ts" } }]),
    msg("t2-res", 1300, "", [{ id: "tc2", name: "tool", result: { isError: false, output: "data" } }]),
    msg("reply", 1400, "All done.", []),
    { id: "e", at: 1500, promptId: "p1", kind: "prompt", status: "finished", text: "check" },
  ];
  const spans = langfuseSpans("sb", acpEvents, [], true, {}, { harness: "antigravity" });
  const root = spans.find((s) => attr(s, "langfuse.observation.type") === "agent")!;
  expect(spans.filter((s) => attr(s, "langfuse.observation.type") === "tool").map((s) => s.name)).toEqual([
    "run_command",
    "read_file",
  ]);
  expect([attr(root, "langfuse.observation.output"), attr(root, "langfuse.trace.metadata.ttft_ms")]).toEqual([
    "All done.",
    "400",
  ]);
  expect(langfuseTurnScores("sb", acpEvents).find((s) => s.name === "ttft_ms")?.value).toBe(400);

  const toolOnlyRoot = langfuseSpans("sb", [...acpEvents.slice(0, 3), acpEvents.at(-1)!], [], true).find(
    (s) => attr(s, "langfuse.observation.type") === "agent",
  )!;
  expect([
    attr(toolOnlyRoot, "langfuse.observation.output"),
    attr(toolOnlyRoot, "langfuse.trace.metadata.ttft_ms"),
  ]).toEqual([undefined, undefined]);
});

test("Langfuse logs secret-free failures, retries 5xx/429/timeout with capped backoff, and fails fast on 400/401/403", async () => {
  const baseMs = 1_700_000_000_000;
  const { db, counters, org } = await settledBoatTurn("transient");
  const logs: string[] = [];
  const replies: (() => Response)[] = [
    () => new Response("err", { status: 503 }),
    () => new Response("slow", { status: 429 }),
    () => {
      throw new DOMException("secret_placeholder timed out", "TimeoutError");
    },
    () => new Response("gw", { status: 502 }),
    () => new Response("down", { status: 500 }),
  ];
  let idx = 0;
  const exporter = createLangfuse(db, key, (async (_u, _i) => replies[idx++]!()) as typeof fetch, {
    logError: (line) => logs.push(line),
    now: () => baseMs,
  });
  const jobState = async () =>
    (
      await db.query<{ state: string; run_after: Date }>(
        "select state, run_after from jobs where kind='langfuse_export' and org_id=$1",
        [org],
      )
    ).rows[0]!;
  for (const delay of [10_000, 20_000, 40_000, 60_000]) {
    expect(await runExport(db, exporter)).toBe(true);
    const st = await jobState();
    expect([st.state, st.run_after.getTime() - baseMs]).toEqual(["queued", delay]);
    expect(await counters()).toEqual([]);
    await db.query("update jobs set run_after=now()-interval '1 second' where kind='langfuse_export'");
  }
  expect(await runExport(db, exporter)).toBe(true);
  expect((await jobState()).state).toBe("failed");
  expect(await counters()).toEqual([{ exported: "0", failed: "1" }]);
  expect(logs).toHaveLength(5);
  expect([logs[0], logs[1], logs[2]]).toEqual([
    expect.stringContaining(`status=503 orgId=${org} sandboxId=`),
    expect.stringContaining("status=429"),
    expect.stringContaining("reason=TimeoutError"),
  ]);
  expect(logs.join("\n")).not.toContain("secret_placeholder");
  expect(logs.join("\n")).not.toContain("public_placeholder");

  for (const status of [400, 401, 403]) {
    const ff = await settledBoatTurn(`ff-${status}`);
    const ffLogs: string[] = [];
    const ffExporter = createLangfuse(
      ff.db,
      key,
      (async (_u, _i) => new Response("nope", { status })) as typeof fetch,
      {
        logError: (line) => ffLogs.push(line),
        now: () => baseMs,
      },
    );
    expect(await runExport(ff.db, ffExporter)).toBe(true);
    const row = (
      await ff.db.query<{ state: string; attempts: number }>(
        "select state, attempts from jobs where kind='langfuse_export' and org_id=$1",
        [ff.org],
      )
    ).rows[0]!;
    expect(row).toEqual({ state: "failed", attempts: 1 });
    expect(await ff.counters()).toEqual([{ exported: "0", failed: "1" }]);
    expect(ffLogs[0]).toContain(`status=${status}`);
  }
});

test("Langfuse settings route maps AuthUnavailable and DB errors to 503 and oversized bodies to 413", async () => {
  const { db, people } = await database();
  const adminAuth = async () => ({
    ok: true as const,
    caller: { userId: people.admin, via: "service" as const, orgs: [{ orgId: people.org, role: "admin" as const }] },
  });
  const unavailRoute = createLangfuse(db, key).route(async () => {
    throw new AuthUnavailable("down");
  });
  expect((await unavailRoute(settingsRequest(people.org, "GET")))?.status).toBe(503);

  const dbLogs: string[] = [];
  const brokenSql: Sql = {
    query: async () => {
      throw new Error("db secret_placeholder boom");
    },
  };
  const brokenRoute = createLangfuse(brokenSql, key, fetch, { logError: (l) => dbLogs.push(l) }).route(adminAuth);
  expect((await brokenRoute(settingsRequest(people.org, "GET")))?.status).toBe(503);
  expect(dbLogs[0]).toContain(`orgId=${people.org}`);
  expect(dbLogs[0]).not.toContain("secret_placeholder");

  const route = createLangfuse(db, key).route(adminAuth);
  const big = JSON.stringify({ publicKey: "a".repeat(20_000), secretKey: "b" });
  const req = (method: string, body: string, suffix = "") =>
    route(new Request(`https://armada.test/api/v1/orgs/${people.org}/langfuse${suffix}`, { method, body }));
  expect([
    (await req("PUT", big))?.status,
    (await req("POST", big, "/test"))?.status,
    (await req("PUT", "bad"))?.status,
  ]).toEqual([413, 413, 400]);
});

test("repo-backed turn export expedites pr_scan and idempotent pr_linked score upsert reuses score identity", async () => {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  const enc = await encryptSecret("fixture_tok", key);
  await db.query(
    `insert into github_connections(user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at)
     values($1,123,'owner','Owner',$2,$2,now()+interval '1 hour')`,
    [people.owner, enc],
  );
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,task_prompt_id,pull_request_source)
     select $1,g.id,g.org_id,g.owner_id,'boat_pr_race','codex','ready','turn-1',
       jsonb_build_object('connectionEpoch',c.connection_epoch,'repositories',
         jsonb_build_array(jsonb_build_object('url','https://github.com/org/repo.git','dir','repo')))
     from goldens g join github_connections c on c.user_id=g.owner_id where g.owner_id=$2 and g.visibility='private' limit 1`,
    [id, people.owner],
  );
  await db.query("select public.enqueue_webhook_turn($1,'disabled-turn','finished')", [id]);
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'full',$2)", [
    people.org,
    await encryptConfig(),
  ]);
  const store = createJobsStore(db);
  const futureRunAfter = new Date(Date.now() + 15 * 60_000);
  await store.enqueue("pr_scan", id, 1, "periodic", null, {
    orgId: people.org,
    maxAttempts: 3,
    runAfter: futureRunAfter,
  });
  await db.query("select public.enqueue_webhook_turn($1,'turn-1','finished')", [id]);

  const sent: { url: string; body: string }[] = [];
  let wakes = 0;
  const unsub = runtimeWakes.subscribe(JOBS_WAKE, () => wakes++);
  const exporter = createLangfuse(db, key, (async (url, init) => {
    sent.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(null, { status: 200 });
  }) as typeof fetch);
  try {
    expect(await runExport(db, exporter, new AbortController().signal, store)).toBe(true);
    const { run_after } = (
      await db.query<{ run_after: Date }>("select run_after from jobs where kind='pr_scan' and sandbox_id=$1", [id])
    ).rows[0]!;
    expect([wakes > 0, run_after.getTime() < futureRunAfter.getTime()]).toEqual([true, true]);
    const initial = sent
      .filter((r) => r.url.endsWith("/scores"))
      .map((r) => JSON.parse(r.body))
      .find((s) => s.name === "pr_linked");
    expect(initial).toEqual(langfusePrLinkedScore(id, "turn-1", false));

    const upserts: unknown[] = [];
    const send = (async (_u: Parameters<typeof fetch>[0], init?: RequestInit) => {
      upserts.push(JSON.parse(String(init?.body ?? "")));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await db.query("select public.enqueue_webhook_turn($1,'dropped-turn','finished')", [id]);
    await db.query("update org_langfuse set enabled=false where org_id=$1", [people.org]);
    expect(await runExport(db, exporter, new AbortController().signal, store)).toBe(true);
    await db.query("update org_langfuse set enabled=true where org_id=$1", [people.org]);
    expect([await upsertLangfusePrLinkedScores(db, key, id, { send }), upserts]).toEqual([
      1,
      [{ ...initial, value: 1 }],
    ]);
    const timeoutLogs: string[] = [];
    const callerSignal = new AbortController().signal;
    expect(
      await upsertLangfusePrLinkedScores(db, key, id, {
        signal: callerSignal,
        logError: (line) => timeoutLogs.push(line),
        send: Object.assign(async () => Promise.reject(new DOMException("hung", "TimeoutError")), {
          preconnect: fetch.preconnect,
        }),
      }),
    ).toBe(0);
    expect([callerSignal.aborted, timeoutLogs[0]?.includes("reason=TimeoutError")]).toEqual([false, true]);

    wakes = 0;
    await db.query("delete from jobs where kind='pr_scan' and sandbox_id=$1", [id]);
    await db.query("select public.enqueue_webhook_turn($1,'turn-2','finished')", [id]);
    sent.length = 0;
    const overlapExporter = createLangfuse(db, key, (async (url, init) => {
      const href = String(url);
      sent.push({ url: href, body: String(init?.body ?? "") });
      if (href.endsWith("/traces"))
        await db.query("update sandboxes set pull_requests=$2::jsonb where id=$1", [
          id,
          JSON.stringify([prFix("org/repo", 7, "open", "feat/x")]),
        ]);
      return new Response(null, { status: 200 });
    }) as typeof fetch);
    expect(await runExport(db, overlapExporter, new AbortController().signal, store)).toBe(true);
    const turn2PrScores = sent
      .filter((r) => r.url.endsWith("/scores"))
      .map((r) => JSON.parse(r.body) as ReturnType<typeof langfusePrLinkedScore>)
      .filter((s) => s.name === "pr_linked");
    expect(turn2PrScores).toEqual([
      langfusePrLinkedScore(id, "turn-2", false),
      langfusePrLinkedScore(id, "turn-2", true),
    ]);
    expect([
      wakes > 0,
      (await db.query("select state from jobs where kind='pr_scan' and sandbox_id=$1", [id])).rows,
    ]).toEqual([true, [{ state: "queued" }]]);
  } finally {
    unsub();
  }
});

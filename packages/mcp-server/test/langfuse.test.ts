import { expect, spyOn, test } from "bun:test";
import type { AgentEvent, Sql } from "@armada/core";
import { decryptSecret, encryptSecret } from "@armada/core/server";
import { createJobsRunner, type JobStore } from "../src/jobs/runner.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { createLangfuse, langfuseSpans } from "../src/langfuse.ts";
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
    content_mode: "full",
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

test.each(["full", "metadata", "tainted"])("runtime OTLP archive export with %s policy", async (mode) => {
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
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'full',$2)", [
    people.org,
    await encryptConfig(),
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
  if (mode === "metadata")
    await db.query("update org_langfuse set content_mode='metadata' where org_id=$1", [people.org]);
  if (mode === "tainted") await db.query("update sandboxes set application_secret_tainted=true where id=$1", [id]);
  const requests: Request[] = [];
  const exporter = createLangfuse(db, key, (async (url, init) => {
    requests.push(url instanceof Request ? new Request(url, init) : new Request(String(url), init));
    return new Response(null, { status: 200 });
  }) as typeof fetch);
  expect(await runExport(db, exporter, new AbortController().signal)).toBe(true);
  expect(requests[0]?.url).toBe("https://langfuse.test/api/public/otel/v1/traces");
  expect(requests[0]?.headers.get("x-langfuse-ingestion-version")).toBe("4");
  const body = (await requests[0]!.json()) as {
    resourceSpans: { scopeSpans: { spans: { attributes: { key: string; value: { stringValue: string } }[] }[] }[] }[];
  };
  const attributes = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
  expect(attributes.find((a) => a.key === "langfuse.observation.output")?.value.stringValue).toBe(
    mode === "full" ? "Hello" : undefined,
  );
  expect(
    attributes.find((a: { key: string }) => a.key === "langfuse.observation.usage_details")!.value.stringValue,
  ).toBe('{"output":0}');
});

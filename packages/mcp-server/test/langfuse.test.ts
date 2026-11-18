import { expect, test } from "bun:test";
import type { AgentEvent, Provider } from "@armada/core";
import { decryptSecret, encryptSecret } from "@armada/core/server";
import { normalizeEvent } from "@armada/provider-boat";
import { createLangfuse, langfuseSpans } from "../src/langfuse.ts";
import { createNativeWebhookPrompts } from "../src/native-webhook-prompts.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";

const database = rowOnlyDatabase();
const noNativeProvider = async () => {
  throw Error("unexpected native provider read");
};
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
  expect(full[0]?.traceId).toBe(metadata[0]?.traceId);
  for (const text of ["customer_prompt", "customer_reply", "customer_argument", "customer_result", "customer_failure"])
    expect(JSON.stringify(full)).toContain(text);
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
test("only an org admin can store encrypted configuration and keys are never returned", async () => {
  const calls: unknown[][] = [];
  const exporter = createLangfuse(
    {
      query: async <T>(_sql: string, params: unknown[] = []) => {
        calls.push(params);
        return { rows: [] as T[] };
      },
    },
    key,
    noNativeProvider,
  );
  const orgId = "00000000-0000-0000-0000-000000000001";
  const request = () =>
    new Request(`https://armada.test/api/v1/orgs/${orgId}/langfuse`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        contentMode: "metadata",
        host: "https://langfuse.test",
        publicKey: "public_placeholder",
        secretKey: "secret_placeholder",
      }),
    });
  const denied = exporter.route(async () => ({
    ok: true,
    caller: { userId: "user", via: "service", orgs: [{ orgId, role: "member" }] },
  }));
  expect((await denied(request()))?.status).toBe(403);
  expect(calls).toHaveLength(0);
  const allowed = exporter.route(async () => ({
    ok: true,
    caller: { userId: "user", via: "service", orgs: [{ orgId, role: "admin" }] },
  }));
  const response = await allowed(request());
  expect(response?.status).toBe(200);
  expect(await response?.text()).not.toContain("placeholder");
  expect(JSON.stringify(calls)).not.toContain("placeholder");
  expect(JSON.parse(await decryptSecret(Buffer.from(calls[0]?.[3] as string, "hex"), key))).toMatchObject({
    secretKey: "secret_placeholder",
  });
});

test("native settlement exports once and a new server reads only its organization's durable totals", async () => {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,task_prompt_id)
     select $1,id,org_id,owner_id,'native_export','claude','ready','turn'
     from goldens where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner],
  );
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'full',$2)", [
    people.org,
    await encryptConfig(),
  ]);
  let historyAvailable = true;
  const provider = {
    id: "boat",
    getPrompt: async () => ({ promptId: "turn", status: "finished", done: true }),
    events: async () => {
      if (!historyAvailable) throw Error("history_unavailable");
      const history: AgentEvent[] = [
        { kind: "prompt", id: "rewritten", at: 1000, promptId: "turn", status: "finished", text: "customer_prompt" },
        events[1]!,
        { kind: "other", id: "limit", at: 1200, promptId: "turn", type: "usage_limit", data: {} },
      ];
      return { events: history, cursor: "native", hasMore: false };
    },
  } satisfies Pick<Provider, "id" | "events" | "getPrompt">;
  const signal = new AbortController().signal;
  const native = createNativeWebhookPrompts(db, async () => provider);
  expect(await native.reconcileOne(signal)).toBe(true);

  let payload = "";
  let responseStatus = 200;
  const exporter = createLangfuse(db, key, async () => ({ provider, providerSandboxId: "native_export" }), (async (
    _url,
    init,
  ) => {
    payload = String(init?.body);
    return new Response(null, { status: responseStatus });
  }) as typeof fetch);
  expect(await exporter.reconcileOne(signal)).toBe(true);
  expect(payload).toContain("customer_reply");
  expect(payload).toContain("customer_prompt");
  expect(payload).toContain("timing_incomplete");
  const generation = JSON.parse(payload).resourceSpans[0].scopeSpans[0].spans[0];
  expect(generation.status).toEqual({ code: 2 });
  expect(generation.endTimeUnixNano).toBe(generation.startTimeUnixNano);
  expect(BigInt(generation.endTimeUnixNano)).toBeGreaterThan(1200000000n);
  await db.query("select public.enqueue_webhook_turn($1,'turn','failed')", [id]);
  expect(await exporter.reconcileOne(signal)).toBe(false);

  const restarted = createLangfuse(db, key, noNativeProvider);
  const read = async (orgId: string) => {
    const route = restarted.route(async () => ({
      ok: true,
      caller: {
        userId: orgId === people.org ? people.admin : people.member,
        via: "service",
        orgs: [{ orgId, role: "admin" }],
      },
    }));
    const response = await route(new Request(`https://armada.test/api/v1/orgs/${orgId}/langfuse`));
    if (!response) throw Error("missing Langfuse response");
    return (await response.json()) as {
      enabled: boolean;
      content_mode?: string;
      counters: { exported: number; failed: number; dropped: number };
      lastExportAt: string | null;
    };
  };
  const beforeFailure = await read(people.org);
  expect(beforeFailure).toEqual({
    enabled: true,
    content_mode: "full",
    counters: { exported: 1, failed: 0, dropped: 0 },
    lastExportAt: expect.any(String),
  });
  // A history read error on a fresh receipt is retried; once the receipt is no
  // longer fresh, the saved terminal evidence is exported as a marked observation.
  payload = "";
  historyAvailable = false;
  await db.query("select public.enqueue_webhook_turn($1,'unavailable','finished')", [id]);
  expect(await exporter.reconcileOne(signal)).toBe(true);
  expect(payload).toBe("");
  await db.query(
    "update langfuse_turn_exports set observed_at=observed_at-interval '2 minutes',lease_until=null where prompt_id='unavailable'",
  );
  expect(await exporter.reconcileOne(signal)).toBe(true);
  const marked = JSON.parse(payload).resourceSpans[0].scopeSpans[0].spans;
  expect(marked).toHaveLength(1);
  expect(marked[0].status).toEqual({ code: 1 });
  expect(JSON.stringify(marked)).toContain("history_unavailable");
  expect(JSON.stringify(marked)).not.toContain("customer_");
  const afterMarked = await read(people.org);
  expect(afterMarked.counters).toEqual({ exported: 2, failed: 0, dropped: 0 });

  historyAvailable = true;
  responseStatus = 503;
  await db.query("select public.enqueue_webhook_turn($1,'rejected','finished')", [id]);
  expect(await exporter.reconcileOne(signal)).toBe(true);
  payload = "";
  await db.query("select public.enqueue_webhook_turn($1,'disabled','finished')", [id]);
  await db.query("update org_langfuse set enabled=false where org_id=$1", [people.org]);
  expect(await exporter.reconcileOne(signal)).toBe(true);
  expect(payload).toBe("");
  expect(await read(people.org)).toEqual({
    enabled: false,
    content_mode: "full",
    counters: { exported: 2, failed: 1, dropped: 1 },
    lastExportAt: afterMarked.lastExportAt,
  });
  await db.query("select public.enqueue_webhook_turn($1,'settled_while_disabled','finished')", [id]);
  await db.query("update org_langfuse set enabled=true where org_id=$1", [people.org]);
  await db.query("select public.enqueue_webhook_turn($1,'settled_while_disabled','finished')", [id]);
  expect(await exporter.reconcileOne(signal)).toBe(false);
  expect(await read(people.otherOrg)).toEqual({
    enabled: false,
    counters: { exported: 0, failed: 0, dropped: 0 },
    lastExportAt: null,
  });
});

async function settledBoatTurn(prompt: string) {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,task_prompt_id)
     select $1,id,org_id,owner_id,'boat_export','codex','ready',$3
     from goldens where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner, prompt],
  );
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'full',$2)", [
    people.org,
    await encryptConfig(),
  ]);
  const receipt = { id: "boat", getPrompt: async () => ({ promptId: prompt, status: "failed", done: true }) } as const;
  await createNativeWebhookPrompts(db, async () => receipt as Pick<Provider, "id" | "getPrompt">).reconcileOne(
    new AbortController().signal,
  );
  const counters = async () =>
    (
      await db.query<{ exported: string; failed: string }>(
        "select exported::text,failed::text from org_langfuse_export_stats where org_id=$1",
        [people.org],
      )
    ).rows;
  return { db, counters };
}

test("full-mode native Boat content is credential-redacted before it is sent", async () => {
  const { db } = await settledBoatTurn("turn");
  // Scanner-positive token bytes exist only at runtime, never as a fixture literal.
  const token = ["ghp", "x".repeat(36)].join("_");
  const raw = [
    { id: "p", timestamp: 1000, taskId: "turn", type: "prompt", data: { prompt: `use ${token}`, status: "running" } },
    {
      id: "r",
      timestamp: 1100,
      taskId: "turn",
      type: "response",
      data: {
        content: `printed ${token}`,
        tools: [
          {
            use: { id: "t", name: "exec", input: { env: { GH: token }, [token]: "keyed" } },
            result: { content: [token, { [`tokens/${token}`]: true }] },
          },
        ],
      },
    },
    { id: "f", timestamp: 1200, taskId: "turn", type: "prompt", data: { status: "failed", error: `denied ${token}` } },
  ];
  const provider = {
    id: "boat",
    events: async () => ({ events: raw.map((e) => normalizeEvent(e as never)), cursor: "native", hasMore: false }),
  } satisfies Pick<Provider, "id" | "events">;
  let payload = "";
  const exporter = createLangfuse(db, key, async () => ({ provider, providerSandboxId: "boat_export" }), (async (
    _url,
    init,
  ) => {
    payload = String(init?.body);
    return new Response(null, { status: 200 });
  }) as typeof fetch);
  expect(await exporter.reconcileOne(new AbortController().signal)).toBe(true);
  expect(payload).toContain("printed ***");
  expect(payload).toContain("denied ***");
  expect(payload).toContain("keyed");
  expect(payload).toContain("tokens/***");
  expect(payload).not.toContain(token);
});

test("an in-flight native history read that outlives its deadline does not hold the export", async () => {
  const { db, counters } = await settledBoatTurn("turn");
  let deadline = new AbortController();
  let resolutions = 0;
  // Provider resolution never settles and never observes the signal, like a stalled SQL read.
  const held = () => {
    resolutions++;
    queueMicrotask(() => deadline.abort());
    return new Promise<never>(() => {});
  };
  const payloads: string[] = [];
  const exporter = createLangfuse(
    db,
    key,
    held,
    (async (_url, init) => {
      payloads.push(String(init?.body));
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    () => deadline.signal,
  );
  // A fresh receipt is retried later instead of exported without history.
  expect(await exporter.reconcileOne(new AbortController().signal)).toBe(true);
  expect(resolutions).toBe(1);
  expect(payloads).toHaveLength(0);

  // The stalled read is still outstanding: the next claim does not start another one.
  deadline = new AbortController();
  await db.query("update langfuse_turn_exports set lease_until=null");
  expect(await exporter.reconcileOne(new AbortController().signal)).toBe(true);
  expect(resolutions).toBe(1);
  expect(payloads).toHaveLength(0);

  // Once the receipt has aged, the saved receipt is exported and counted.
  await db.query("update langfuse_turn_exports set lease_until=null,observed_at=observed_at-interval '2 minutes'");
  expect(await exporter.reconcileOne(new AbortController().signal)).toBe(true);
  expect(resolutions).toBe(1);
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toContain("history_unavailable");
  expect(await counters()).toEqual([{ exported: "1", failed: "0" }]);
});

test("a timed-out native history exports the receipt, and an abandoned job settles as failed", async () => {
  const { db, counters } = await settledBoatTurn("turn");
  await db.query("update langfuse_turn_exports set observed_at=observed_at-interval '2 minutes'");
  let unbounded = false;
  const provider = {
    id: "boat",
    events: async ({ signal }: { signal?: AbortSignal }) => {
      signal?.throwIfAborted();
      unbounded = true;
      throw Error("history read must observe its deadline");
    },
  } as unknown as Pick<Provider, "id" | "events">;
  const payloads: string[] = [];
  const exporter = createLangfuse(
    db,
    key,
    async () => ({ provider, providerSandboxId: "boat_export" }),
    (async (_url, init) => {
      payloads.push(String(init?.body));
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    () => AbortSignal.abort(),
  );
  // The worker tick itself is still live: only the history deadline expired.
  expect(await exporter.reconcileOne(new AbortController().signal)).toBe(true);
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toContain("history_unavailable");
  expect(unbounded).toBe(false);
  expect(await counters()).toEqual([{ exported: "1", failed: "0" }]);

  // A job whose previous claims were all abandoned by tick timeouts or shutdown
  // reaches a durable outcome instead of being reclaimed forever.
  await db.query("select public.enqueue_webhook_turn(sandbox_id,'abandoned','finished') from langfuse_turn_exports");
  await db.query("update langfuse_turn_exports set attempts=5 where prompt_id='abandoned'");
  expect(await exporter.reconcileOne(new AbortController().signal)).toBe(true);
  expect(payloads).toHaveLength(1);
  expect(await counters()).toEqual([{ exported: "1", failed: "1" }]);
  expect(await exporter.reconcileOne(new AbortController().signal)).toBe(false);
});

test("native Modal export waits for the terminal journal event after a live receipt", async () => {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  await db.query(
    `with source as (
       insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,
          modal_workspace,modal_environment,modal_app_id,config)
       values($2,$3,'modal-export','private','modal','modal-master','modal-image','workspace','main','app',
          '{"repos":[{"url":"https://github.com/example/web.git","branch":"main","dir":"web"}],"init":[]}')
       returning id
     )
     insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,task_prompt_id)
     select $1,id,$2,$3,'modal','modal_export','codex','ready','turn' from source`,
    [id, people.org, people.owner],
  );
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'full',$2)", [
    people.org,
    await encryptConfig(),
  ]);
  let history = events.slice(0, 1);
  const provider = {
    id: "modal",
    getPrompt: async () => ({ promptId: "turn", status: "failed", done: true }),
    events: async () => {
      if (history === events) {
        await db.query("update sandboxes set usage_turns=$2::jsonb where id=$1", [
          id,
          JSON.stringify({
            turnCount: 1,
            turns: [
              { promptId: "turn", model: "codex_fixture", inputTokens: 4, outputTokens: 2, pricing: { usd: 0.12 } },
            ],
          }),
        ]);
      }
      return { events: history, cursor: "native", hasMore: false };
    },
  } satisfies Pick<Provider, "id" | "getPrompt" | "events">;
  const signal = new AbortController().signal;
  await createNativeWebhookPrompts(db, async () => provider).reconcileOne(signal);
  const payloads: string[] = [];
  const exporter = createLangfuse(db, key, async () => ({ provider, providerSandboxId: "modal_export" }), (async (
    _url,
    init,
  ) => {
    payloads.push(String(init?.body));
    return new Response(null, { status: 200 });
  }) as typeof fetch);

  expect(await exporter.reconcileOne(signal)).toBe(true);
  expect(payloads).toEqual([]);
  // Pending keeps the job open behind a short lease; assert the row, not elapsed time.
  expect(
    (
      await db.query<{ open: boolean; leased: boolean }>(
        "select completed_at is null as open,lease_id is null and lease_until is not null as leased from langfuse_turn_exports where sandbox_id=$1",
        [id],
      )
    ).rows,
  ).toEqual([{ open: true, leased: true }]);
  history = events;
  await db.query("update langfuse_turn_exports set lease_until=now()-interval '1 second' where sandbox_id=$1", [id]);
  expect(await exporter.reconcileOne(signal)).toBe(true);
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toContain("customer_reply");
  expect(payloads[0]).toContain("langfuse.observation.cost_details");
});

test("worker exports the persisted usage envelope and reconstructed archive through OTLP", async () => {
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
  const requests: Request[] = [];
  const exporter = createLangfuse(db, key, noNativeProvider, (async (url, init) => {
    requests.push(url instanceof Request ? new Request(url, init) : new Request(String(url), init));
    return new Response(null, { status: 200 });
  }) as typeof fetch);
  expect(await exporter.reconcileOne(new AbortController().signal)).toBe(true);
  expect(requests[0]?.url).toBe("https://langfuse.test/api/public/otel/v1/traces");
  expect(requests[0]?.headers.get("x-langfuse-ingestion-version")).toBe("4");
  const body = (await requests[0]!.json()) as {
    resourceSpans: { scopeSpans: { spans: { attributes: { key: string; value: { stringValue: string } }[] }[] }[] }[];
  };
  const attributes = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
  expect(attributes.find((a: { key: string }) => a.key === "langfuse.observation.output")!.value.stringValue).toBe(
    "Hello",
  );
  expect(
    attributes.find((a: { key: string }) => a.key === "langfuse.observation.usage_details")!.value.stringValue,
  ).toBe('{"output":0}');
});

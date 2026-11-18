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
test("a prompt event with an unknown status never becomes an exported span", () => {
  // Modal native history keeps guest-supplied statuses unvalidated.
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
  const route = createLangfuse(db, key, noNativeProvider).route(async () => ({
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

test("only the organization's admins can change or test settings and members can read status alone", async () => {
  const { db, people } = await database();
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'full',$2)", [
    people.org,
    await encryptConfig(),
  ]);
  const route = createLangfuse(db, key, noNativeProvider).route(async () => ({
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
  let upstream: number | null = 200;
  const route = createLangfuse(db, key, noNativeProvider, (async (url, init) => {
    attempts.push({ url: String(url), init });
    if (upstream === null) throw new DOMException("timeout", "TimeoutError");
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

  upstream = 401;
  expect(await (await probe({ secretKey: "candidate_secret" }))?.json()).toEqual({ status: "rejected" });
  expect(new Headers(attempts[1]?.init?.headers).get("authorization")).toBe(
    `Basic ${Buffer.from("public_placeholder:candidate_secret").toString("base64")}`,
  );
  upstream = null;
  expect(await (await probe({}))?.json()).toEqual({ status: "unreachable" });
  expect(attempts[2]?.init?.headers).toEqual(attempts[0]?.init?.headers);

  expect((await probe({ host: "http://langfuse.test" }))?.status).toBe(400);
  expect((await probe({ host: "https://different.test" }))?.status).toBe(400);
  expect(attempts).toHaveLength(3);
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
      contentMode: string;
      counters: { exported: number; failed: number; dropped: number };
      lastExportAt: string | null;
    };
  };
  const beforeFailure = await read(people.org);
  expect(beforeFailure).toMatchObject({
    enabled: true,
    contentMode: "full",
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
  expect(await read(people.org)).toMatchObject({
    enabled: false,
    contentMode: "full",
    counters: { exported: 2, failed: 1, dropped: 1 },
    lastExportAt: afterMarked.lastExportAt,
  });
  await db.query("select public.enqueue_webhook_turn($1,'settled_while_disabled','finished')", [id]);
  await db.query("update org_langfuse set enabled=true where org_id=$1", [people.org]);
  await db.query("select public.enqueue_webhook_turn($1,'settled_while_disabled','finished')", [id]);
  expect(await exporter.reconcileOne(signal)).toBe(false);
  expect(await read(people.otherOrg)).toMatchObject({
    enabled: false,
    counters: { exported: 0, failed: 0, dropped: 0 },
    lastExportAt: null,
  });
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
  const receipt = { id: "boat", getPrompt: async () => ({ promptId: prompt, status: "failed", done: true }) } as const;
  await createNativeWebhookPrompts(
    db,
    async () => receipt as unknown as Pick<Provider, "id" | "getPrompt" | "events">,
  ).reconcileOne(new AbortController().signal);
  const counters = async () =>
    (
      await db.query<{ exported: string; failed: string }>(
        "select exported::text,failed::text from org_langfuse_export_stats where org_id=$1",
        [people.org],
      )
    ).rows;
  return { db, counters, org: people.org };
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

const secretBinding = { key: "APP", secretId: "00000000-0000-4000-8000-000000000001", version: 1 };
const bindApplicationSecret = {
  template: (db: Awaited<ReturnType<typeof settledBoatTurn>>["db"]) =>
    db.query(
      `insert into template_launch_requests(org_id,actor_id,client_key,digest,template_id,revision_id,manifest,golden_operation_fence_id,sandbox_id,state)
       select org_id,owner_id,'client',repeat('a',64),gen_random_uuid(),gen_random_uuid(),$1::jsonb,gen_random_uuid(),id,'succeeded'
       from sandboxes where boat_id='boat_export'`,
      [JSON.stringify({ definition: { secrets: [secretBinding] } })],
    ),
  docker: async (db: Awaited<ReturnType<typeof settledBoatTurn>>["db"]) =>
    db.query(
      `insert into docker_launch_requests(sandbox_id,actor_epoch,request_hash,request_enc)
       select id,1,repeat('a',64),$1 from sandboxes where boat_id='boat_export'`,
      [await encryptSecret(JSON.stringify({ variables: {}, request: { secrets: [secretBinding] } }), key)],
    ),
  // The irreversible sandbox marker alone, with no launch-request binding.
  tainted: async (db: Awaited<ReturnType<typeof settledBoatTurn>>["db"]) =>
    db.query("update sandboxes set application_secret_tainted=true where boat_id='boat_export'"),
};
for (const mode of ["metadata", "full"] as const)
  for (const [source, bind] of Object.entries(bindApplicationSecret))
    test(`a sandbox with ${source} application-secret bindings exports no provider strings in ${mode} mode`, async () => {
      const { db, counters } = await settledBoatTurn("turn", mode);
      const canary = ["opaque", "application", "canary"].join("-");
      await db.exec("set session_replication_role=replica");
      try {
        await bind(db);
        // A persisted usage row carrying the canary as its model name.
        await db.query("update sandboxes set usage_turns=$1::jsonb where boat_id='boat_export'", [
          JSON.stringify({
            turnCount: 1,
            turns: [{ promptId: "turn", model: `usage-${canary}`, inputTokens: 4, outputTokens: 2 }],
          }),
        ]);
      } finally {
        await db.exec("set session_replication_role=origin");
      }
      const raw = [
        { id: "p", timestamp: 1000, taskId: "turn", type: "prompt", data: { prompt: "print APP", status: "running" } },
        {
          id: "r",
          timestamp: 1100,
          taskId: "turn",
          type: "response",
          data: {
            content: canary,
            model: `model-${canary}`,
            // Provider-controlled names, through the real Boat normalizer.
            tools: [
              { use: { id: "t", name: "exec", input: canary }, result: { content: canary } },
              { use: { id: "u", name: `tool-${canary}` } },
            ],
          },
        },
        { id: "f", timestamp: 1200, taskId: "turn", type: "prompt", data: { status: "failed", error: canary } },
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
      expect(payload).toContain("application_secret_bindings");
      expect(payload).toContain('"name":"tool"');
      expect(payload).not.toContain("exec");
      // Token counts from the usage row still export; its model name does not.
      expect(payload).toContain(String.raw`{\"input\":4,\"output\":2}`);
      expect(payload).not.toContain(canary);
      expect(payload).not.toContain("print APP");
      expect(await counters()).toEqual([{ exported: "1", failed: "0" }]);
    });

for (const [settled, delivered, content] of [
  ["metadata", "full", false],
  ["full", "metadata", false],
  ["full", "full", true],
] as const)
  test(`a turn settled under ${settled} and delivered under ${delivered} ${content ? "exports" : "withholds"} content`, async () => {
    const { db, counters, org } = await settledBoatTurn("turn", settled);
    await db.query("update org_langfuse set content_mode=$2 where org_id=$1", [org, delivered]);
    const canary = ["settled", "transcript", "canary"].join("-");
    const raw = [
      { id: "p", timestamp: 1000, taskId: "turn", type: "prompt", data: { prompt: canary, status: "running" } },
      { id: "r", timestamp: 1100, taskId: "turn", type: "response", data: { content: canary } },
      { id: "f", timestamp: 1200, taskId: "turn", type: "prompt", data: { status: "failed", error: "stopped" } },
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
    expect(payload).toContain("Armada turn");
    expect(payload.includes(canary)).toBe(content);
    expect(await counters()).toEqual([{ exported: "1", failed: "0" }]);
  });

test("a native receipt abandoned after its final failed observation counts one durable drop", async () => {
  const { db, people } = await database();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,task_prompt_id)
     select $1,id,org_id,owner_id,'boat_abandoned','codex','ready','turn'
     from goldens where owner_id=$2 and visibility='private' limit 1`,
    [crypto.randomUUID(), people.owner],
  );
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'full',$2)", [
    people.org,
    await encryptConfig(),
  ]);
  const provider = {
    id: "boat",
    getPrompt: async () => {
      throw Error("provider_unavailable");
    },
  } as const;
  const native = createNativeWebhookPrompts(
    db,
    async () => provider as unknown as Pick<Provider, "id" | "getPrompt" | "events">,
  );
  const signal = new AbortController().signal;
  const dropped = async () =>
    (
      await db.query<{ dropped: string }>("select dropped::text from org_langfuse_export_stats where org_id=$1", [
        people.org,
      ])
    ).rows[0]?.dropped ?? "0";
  for (let attempt = 1; attempt <= 5; attempt++) {
    expect(await dropped()).toBe("0");
    await db.query("update native_webhook_prompts set next_attempt_at=now()");
    expect(await native.reconcileOne(signal)).toBe(true);
  }
  expect(await dropped()).toBe("1");
  await db.query("update native_webhook_prompts set next_attempt_at=now()");
  expect(await native.reconcileOne(signal)).toBe(false);
  expect(await dropped()).toBe("1");
});

test("an exhausted receipt whose turn lifecycle reconciliation already settled counts no drop", async () => {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,task_prompt_id)
     select $1,id,org_id,owner_id,'boat_settled','codex','ready','turn'
     from goldens where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner],
  );
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'full',$2)", [
    people.org,
    await encryptConfig(),
  ]);
  // Lifecycle reconciliation settles the turn but leaves its receipt pending.
  await db.query("select public.enqueue_webhook_turn($1,'turn','finished')", [id]);
  const provider = {
    id: "boat",
    getPrompt: async () => {
      throw Error("provider_unavailable");
    },
  } as const;
  const native = createNativeWebhookPrompts(
    db,
    async () => provider as unknown as Pick<Provider, "id" | "getPrompt" | "events">,
  );
  for (let attempt = 1; attempt <= 5; attempt++) {
    await db.query("update native_webhook_prompts set next_attempt_at=now()");
    expect(await native.reconcileOne(new AbortController().signal)).toBe(true);
  }
  // The same receipt left behind by a cancelled final claim is released without a drop.
  await db.query("update native_webhook_prompts set lease_id=$1,lease_until=now()-interval '1 second'", [
    crypto.randomUUID(),
  ]);
  expect(await native.reconcileOne(new AbortController().signal)).toBe(false);
  expect((await db.query("select failures,lease_id from native_webhook_prompts")).rows).toEqual([
    { failures: 5, lease_id: null },
  ]);
  expect((await db.query("select coalesce(sum(dropped),0)::int as n from org_langfuse_export_stats")).rows).toEqual([
    { n: 0 },
  ]);
});

test("a native receipt whose final observations are all cancelled counts one durable drop", async () => {
  const { db, people } = await database();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,task_prompt_id)
     select $1,id,org_id,owner_id,'boat_cancelled','codex','ready','turn'
     from goldens where owner_id=$2 and visibility='private' limit 1`,
    [crypto.randomUUID(), people.owner],
  );
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'full',$2)", [
    people.org,
    await encryptConfig(),
  ]);
  let cancel = new AbortController();
  // The provider read is cancelled by the worker tick each time, like a timeout or shutdown.
  const provider = {
    id: "boat",
    getPrompt: async () => {
      cancel.abort(Error("tick_cancelled"));
      throw Error("aborted");
    },
  } as const;
  const native = createNativeWebhookPrompts(
    db,
    async () => provider as unknown as Pick<Provider, "id" | "getPrompt" | "events">,
  );
  const dropped = async () =>
    (
      await db.query<{ dropped: string }>("select dropped::text from org_langfuse_export_stats where org_id=$1", [
        people.org,
      ])
    ).rows[0]?.dropped ?? "0";
  for (let attempt = 1; attempt <= 5; attempt++) {
    await db.query("update native_webhook_prompts set next_attempt_at=now(),lease_until=now()-interval '1 second'");
    cancel = new AbortController();
    await expect(native.reconcileOne(cancel.signal)).rejects.toThrow("tick_cancelled");
    await native.drain();
    expect(await dropped()).toBe("0");
  }
  // The fifth lease expires; a fresh worker finalizes it exactly once.
  await db.query("update native_webhook_prompts set lease_until=now()-interval '1 second'");
  const fresh = createNativeWebhookPrompts(
    db,
    async () => provider as unknown as Pick<Provider, "id" | "getPrompt" | "events">,
  );
  expect(await fresh.reconcileOne(new AbortController().signal)).toBe(false);
  expect(await dropped()).toBe("1");
  expect(await fresh.reconcileOne(new AbortController().signal)).toBe(false);
  expect(await dropped()).toBe("1");
  expect((await db.query("select failures,lease_id,completed_at from native_webhook_prompts")).rows).toEqual([
    { failures: 5, lease_id: null, completed_at: null },
  ]);
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

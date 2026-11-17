import { expect, spyOn, test } from "bun:test";
import type { AgentEvent } from "@armada/core";
import { decryptSecret } from "@armada/core/server";
import { createLangfuse, langfuseSpans } from "../src/langfuse.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";

const database = rowOnlyDatabase();

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
  const metadata = langfuseSpans("sandbox", events, [], false);
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
  expect(langfuseSpans("sandbox", events.slice(1), [], true)).toEqual([]);
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
  const key = Buffer.alloc(32, 1).toString("base64");
  const calls: unknown[][] = [];
  const exporter = createLangfuse(
    {
      query: async <T>(_sql: string, params: unknown[] = []) => {
        calls.push(params);
        return { rows: [] as T[] };
      },
    },
    key,
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

test("export scheduling never waits for settings and drops overload while counting worker failures", async () => {
  const scheduled: (() => Promise<void>)[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => Promise<void>) => {
    scheduled.push(callback);
    return 0;
  }) as unknown as typeof setTimeout);
  let reads = 0;
  const exporter = createLangfuse(
    {
      query: async () => {
        reads++;
        throw Error("offline");
      },
    },
    "unused",
  );
  try {
    for (let i = 0; i < 65; i++) exporter.enqueue("sandbox", events, 3);
    expect(reads).toBe(0);
    expect(exporter.counters.dropped).toBe(1);
    await scheduled[0]!();
    expect(exporter.counters.failed).toBe(64);
    expect(reads).toBe(64);
  } finally {
    timer.mockRestore();
  }
});

test("worker exports the persisted usage envelope and reconstructed archive through OTLP", async () => {
  const { encryptSecret } = await import("@armada/core/server");
  const { db, people } = await database();
  const key = Buffer.alloc(32, 1).toString("base64");
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
  const encrypted = await encryptSecret(
    JSON.stringify({ host: "https://langfuse.test", publicKey: "public_placeholder", secretKey: "secret_placeholder" }),
    key,
  );
  await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'full',$2)", [
    people.org,
    encrypted,
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
  for (const [index, event] of archive.entries())
    await db.query("insert into runtime_events(sandbox_id,sequence,epoch,event_enc) values($1,$2,'1',$3)", [
      id,
      index + 1,
      await encryptSecret(JSON.stringify(event), key),
    ]);
  const scheduled: (() => Promise<void>)[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => Promise<void>) => {
    scheduled.push(callback);
    return 0;
  }) as unknown as typeof setTimeout);
  const requests: Request[] = [];
  const exporter = createLangfuse(db, key, (async (url, init) => {
    requests.push(url instanceof Request ? new Request(url, init) : new Request(String(url), init));
    return new Response(null, { status: 200 });
  }) as typeof fetch);
  try {
    exporter.enqueue(id, [events[2]!], 4);
    await scheduled[0]!();
  } finally {
    timer.mockRestore();
  }
  expect(exporter.counters).toEqual({ exported: 1, failed: 0, dropped: 0 });
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

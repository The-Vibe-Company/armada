import { expect, test } from "bun:test";
import type { AgentEvent } from "@armada/core";
import { decryptSecret } from "@armada/core/server";
import { createLangfuse, langfuseSpans } from "../src/langfuse.ts";

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

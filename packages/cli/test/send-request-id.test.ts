import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const id = "11111111-1111-4111-8111-111111111111";
const key = "a2222222-b222-4222-8222-222222222222";
async function send(extra: string[], status = 200) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let error = "";
  const auth = {
    env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture-session" },
    session: memorySessionStore(),
    now: () => new Date(),
    open: () => {},
    out: () => {},
    err: (text: string) => {
      error += text;
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      calls.push({ path: new URL(request.url).pathname, body: (await request.json()) as Record<string, unknown> });
      return Response.json(
        status === 200
          ? { id, promptId: "prompt", conversationId: "conversation", status: "queued" }
          : { error: { code: status === 409 ? "conflict" : "unavailable", message: "temporary" } },
        { status },
      );
    },
  };
  const exit = await run(["send", id, "continue the same conversation", ...extra], auth, { auth });
  return { exit, calls, error };
}

test("ordinary CLI send uses one provider-neutral request shape with generated or explicit UUID", async () => {
  const generated = await send([]);
  expect(generated.exit).toBe(0);
  expect(generated.error).toContain("Waking the sandbox if paused");
  expect(generated.error).not.toContain("uncertain delivery");
  expect(generated.calls).toHaveLength(1);
  expect(generated.calls[0]?.path).toBe("/api/v1/sandbox/send");
  expect(generated.calls[0]?.body).toEqual({
    id,
    prompt: "continue the same conversation",
    request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  const explicit = await send(["--request-id", key.toUpperCase()]);
  expect(explicit.exit).toBe(0);
  expect(explicit.calls[0]?.body.request_id).toBe(key);
  const invalid = await send(["--request-id", "invalid"]);
  expect(invalid.exit).not.toBe(0);
  expect(invalid.calls).toHaveLength(0);
});

test("unknown send delivery reports its stable UUID without retrying the instruction", async () => {
  for (const status of [409, 503]) {
    const failed = await send(["--request-id", key], status);
    expect(failed.exit).not.toBe(0);
    expect(failed.calls).toHaveLength(1);
    expect(failed.error).toContain(`Send request ID: ${key}`);
    expect(failed.error).not.toContain("fixture-session");
  }
});

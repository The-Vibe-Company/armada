import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const id = "11111111-1111-4111-8111-111111111111";
const org = "22222222-2222-4222-8222-222222222222";

async function invoke(args: string[], respond: (path: string) => object, now = () => new Date(0)) {
  const calls: { path: string; method: string | undefined; body: unknown }[] = [];
  let stdout = "";
  let stderr = "";
  const auth = {
    env: { ARMADA_SANDBOX: id, ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture" },
    session: memorySessionStore(),
    now,
    open: () => {},
    out: (text: string) => {
      stdout += text;
    },
    err: (text: string) => {
      stderr += text;
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method, body: JSON.parse(String(init?.body)) });
      return Response.json(respond(path));
    },
  };
  const exit = await run(["stop", ...args, "--json"], auth, { auth });
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return { calls, receipt: JSON.parse(stdout) };
}

test("stop --turn interrupts the current sandbox without stopping the machine", async () => {
  const receipt = { id, interrupted: true };
  expect(await invoke(["--turn"], () => receipt)).toEqual({
    calls: [{ path: "/api/v1/sandbox/interrupt", method: "POST", body: { id } }],
    receipt,
  });
});

test("stop --after waits in the selected organization and requests an idle-only stop", async () => {
  const receipt = { id, status: "stopped" };
  const result = await invoke(["--after", "--timeout", "15", "--org", org], (path) =>
    path.endsWith("/wait") ? { id, status: "ready", prompt: null, settled: true, timedOut: false } : receipt,
  );
  expect(result).toEqual({
    calls: [
      { path: "/api/v1/sandbox/wait", method: "POST", body: { id, org, timeout_seconds: 15 } },
      { path: "/api/v1/sandbox/stop", method: "POST", body: { id, org, only_if_idle: true } },
    ],
    receipt,
  });
});

test.each([
  { seconds: 60, timedOut: true, elapsedMs: 0, status: "running" },
  { seconds: 0, timedOut: false, elapsedMs: 0, status: "ready" },
  { seconds: 1, timedOut: false, elapsedMs: 1_000, status: "ready" },
])(
  "stop --after does not dispatch after its wait budget ($seconds seconds, timeout receipt $timedOut)",
  async ({ seconds, timedOut, elapsedMs, status }) => {
    let nowMs = 0;
    const result = await invoke(
      ["--after", ...(seconds === 60 ? [] : ["--timeout", String(seconds)])],
      () => {
        nowMs = elapsedMs;
        return { id, status, prompt: null, settled: !timedOut, timedOut };
      },
      () => new Date(nowMs),
    );
    expect(result).toEqual({
      calls: [{ path: "/api/v1/sandbox/wait", method: "POST", body: { id, timeout_seconds: seconds } }],
      receipt: { id, status, timedOut: true },
    });
  },
);

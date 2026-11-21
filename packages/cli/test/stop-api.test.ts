import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

test("stop --after posts the parsed lifetime and preserves JSON output, rejecting invalid durations locally", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const org = "22222222-2222-4222-8222-222222222222";
  const result = { id, expiresAt: "2026-11-10T16:00:00.000Z", ttlSeconds: 14_400 };
  const calls: Request[] = [];
  let out = "";
  let err = "";
  const io = {
    out: (text: string) => {
      out += text;
    },
    err: (text: string) => {
      err += text;
    },
  };
  const auth = {
    ...io,
    env: { ARMADA_TOKEN: "fixture-token", ARMADA_URL: "https://armada.test" },
    session: memorySessionStore(),
    now: () => new Date("2026-11-10T12:00:00Z"),
    open: () => {},
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
      return Response.json(result);
    },
  };
  expect(await run(["stop", id, "--after", "4h", "--org", org, "--json"], io, { auth })).toBe(0);
  expect(err).toBe("");
  expect(JSON.parse(out)).toEqual(result);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://armada.test/api/v1/sandbox/extend");
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.headers.get("authorization")).toBe("Bearer fixture-token");
  expect(await calls[0]?.json()).toEqual({ id, org, ttlSeconds: 14_400 });

  out = "";
  err = "";
  expect(await run(["stop", id, "--after", "tomorrow", "--org", org, "--json"], io, { auth })).toBe(2);
  expect(out).toBe("");
  expect(JSON.parse(err).error.message).toContain("--after 'tomorrow' is not a duration");
  expect(calls).toHaveLength(1);
});

test("stop --after preserves closed refusal codes without exposing upstream text", async () => {
  for (const [code, status] of [
    ["extension_not_found", 404],
    ["extension_not_allowed", 403],
    ["extension_state", 409],
    ["extension_maximum", 400],
  ] as const) {
    let err = "";
    const io = {
      out: () => {},
      err: (text: string) => {
        err += text;
      },
    };
    const auth = {
      ...io,
      env: { ARMADA_TOKEN: "fixture", ARMADA_URL: "https://armada.test" },
      session: memorySessionStore(),
      now: () => new Date(),
      open: () => {},
      fetch: async () => Response.json({ error: { code, message: "guest-secret" } }, { status }),
    };
    expect(
      await run(["stop", "11111111-1111-4111-8111-111111111111", "--after", "5m", "--json"], io, { auth }),
    ).not.toBe(0);
    expect(JSON.parse(err).error.code).toBe(code);
    expect(err).not.toContain("guest-secret");
  }
});

test("stop --turn interrupts the current sandbox without stopping the machine", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const result = { id, interrupted: true };
  const requests: Request[] = [];
  let stdout = "";
  const auth = {
    env: { ARMADA_SANDBOX: id, ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture" },
    session: memorySessionStore(),
    now: () => new Date(0),
    open: () => {},
    out: (text: string) => {
      stdout += text;
    },
    err: (text: string) => {
      throw new Error(text);
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
      return Response.json(result);
    },
  };
  expect(await run(["stop", "--turn"], auth, { auth })).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://armada.test/api/v1/sandbox/interrupt");
  expect(await requests[0]?.json()).toEqual({ id });
  expect(JSON.parse(stdout)).toEqual(result);
});

import { expect, jest, test } from "bun:test";
import { SIZED_LAUNCH_ROUTE_V1 } from "@armada/core";
import { CONTROL_TIMEOUT_MS, ControlError } from "../src/lib/control.ts";
import {
  decodeLaunchAttempt,
  encodeLaunchAttempt,
  followLaunch,
  LAUNCH_TIMEOUT_MS,
  launchSandbox,
} from "../src/lib/launch.ts";
import { LAUNCH_KEY_FIELD, launchKeyFor } from "../src/lib/launch-key.ts";

const args = {
  golden: "web",
  provider: "boat" as const,
  org: "11111111-1111-4111-8111-111111111111",
  harness: "claude" as const,
  model: "claude-opus-5-5",
  reasoning_effort: "medium",
  visibility: "org" as const,
  connections: [],
};
const answering = (body: unknown, status = 200, seen: unknown[] = []) => ({
  serverUrl: "https://armada.test/mcp",
  token: "t",
  fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)));
    return Response.json(body, { status });
  }) as typeof fetch,
});

const answeringAt = (routes: string[], body: unknown, status = 200) => ({
  serverUrl: "https://armada.test/mcp",
  token: "t",
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    routes.push(`${new URL(String(input)).pathname} ${String(init?.body)}`);
    return Response.json(body, { status });
  }) as typeof fetch,
});

test("an explicit size or stored defaults use only the versioned sized route; neither uses the legacy one", async () => {
  const routes: string[] = [];
  const ok = { sandbox: { id: "s1" } };
  expect(await launchSandbox(answeringAt(routes, ok), { ...args, size: "large" })).toEqual({ id: "s1" });
  await launchSandbox(answeringAt(routes, ok), { ...args, sizePolicy: true });
  await launchSandbox(answeringAt(routes, ok), args);
  expect(routes.map((route) => route.split(" ")[0])).toEqual([
    SIZED_LAUNCH_ROUTE_V1,
    SIZED_LAUNCH_ROUTE_V1,
    "/api/v1/sandbox/launch",
  ]);
  expect(JSON.parse(routes[0]?.slice(routes[0].indexOf(" ") + 1) ?? "")).toMatchObject({
    size: "large",
    sizePolicyVersion: 1,
  });
  expect(JSON.parse(routes[1]?.slice(routes[1].indexOf(" ") + 1) ?? "")).toMatchObject({ sizePolicyVersion: 1 });
  expect(JSON.parse(routes[2]?.slice(routes[2].indexOf(" ") + 1) ?? "")).not.toHaveProperty("sizePolicyVersion");
});

test("an older replica's 404 on the sized route fails the launch once, with no legacy retry", async () => {
  const routes: string[] = [];
  const unknown = { error: { code: "not_found", message: "Unknown route." } };
  const error = await launchSandbox(answeringAt(routes, unknown, 404), { ...args, size: "large" }).catch((e) => e);
  expect(error).toBeInstanceOf(ControlError);
  expect(error.message).toBe("This Armada server does not offer launching with machine sizes yet.");
  expect(routes).toHaveLength(1);
});

test("a provider refusal keeps the server's code, whatever its status", async () => {
  const refusal = { error: { code: "forbidden", message: "Requested size cannot be allocated." } };
  const error = await launchSandbox(answering(refusal, 403), { ...args, size: "xlarge" }).catch((caught) => caught);
  expect(error).toBeInstanceOf(ControlError);
  expect(error).toMatchObject({ code: "forbidden", message: "Requested size cannot be allocated." });
  const seen: unknown[] = [];
  const limit = {
    error: {
      code: "rate_limited",
      message:
        "The Boat plan start limit per day has been reached. Boat says the next start is available at 2026-11-12T08:08:00.000Z.",
    },
  };
  expect(await launchSandbox(answering(limit, 429, seen), args).catch((caught) => caught)).toMatchObject(limit.error);
  expect(seen).toHaveLength(1);
  const unavailable = { error: { code: "payment_required", message: "Plan limit." } };
  expect(await launchSandbox(answering(unavailable, 503), args).catch((caught) => caught)).toMatchObject({
    code: "payment_required",
  });
});

test("the chosen model account is pinned on every launch route, sized or not, alongside the size", async () => {
  const routes: string[] = [];
  const ok = { sandbox: { id: "s1" } };
  const credentialId = "00000000-0000-4000-8000-000000000041";
  const skills = ["review-code@2.0.0"];
  await launchSandbox(answeringAt(routes, ok), { ...args, credentialId, skills, size: "large" });
  await launchSandbox(answeringAt(routes, ok), { ...args, credentialId, skills, sizePolicy: true });
  await launchSandbox(answeringAt(routes, ok), { ...args, credentialId, skills });
  const sent = routes.map((route) => [route.split(" ")[0], JSON.parse(route.slice(route.indexOf(" ") + 1))]);
  expect(sent).toEqual([
    [SIZED_LAUNCH_ROUTE_V1, expect.objectContaining({ credentialId, skills, size: "large", sizePolicyVersion: 1 })],
    [SIZED_LAUNCH_ROUTE_V1, expect.objectContaining({ credentialId, skills, sizePolicyVersion: 1 })],
    ["/api/v1/sandbox/launch", expect.objectContaining({ credentialId, skills })],
  ]);
});

test("Armada access uses only its versioned route and preserves all explicit launch choices", async () => {
  const routes: string[] = [];
  const chosen = {
    ...args,
    harness: "codex" as const,
    model: "gpt-6.1-sol",
    credentialId: "00000000-0000-4000-8000-000000000041",
    armadaAccess: true as const,
    size: "large" as const,
    repo: "web",
    connections: ["selected-mcp"],
    prompt: "task",
  };
  await launchSandbox(answeringAt(routes, { sandbox: { id: "s1" } }), chosen);
  const [path, ...body] = routes[0]!.split(" ");
  expect(path).toBe("/api/v1/sandbox/launch-access-v1");
  expect(JSON.parse(body.join(" "))).toMatchObject({
    armadaAccessVersion: 1,
    armadaAccess: { maxActiveChildren: 3 },
    credentialId: chosen.credentialId,
    harness: "codex",
    model: chosen.model,
    reasoningEffort: "medium",
    size: "large",
    sizePolicyVersion: 1,
    repo: "web",
    connections: ["selected-mcp"],
    prompt: "task",
  });
  routes.length = 0;
  await expect(launchSandbox(answeringAt(routes, { error: { code: "not_found" } }, 404), chosen)).rejects.toThrow(
    "does not offer launching with Armada access",
  );
  expect(routes).toHaveLength(1);
});

test("crafted Armada access without an explicit Codex account is refused before transport", async () => {
  const routes: string[] = [];
  const transport = answeringAt(routes, { sandbox: { id: "s1" } });
  for (const chosen of [
    { ...args, credentialId: "00000000-0000-4000-8000-000000000041" },
    { ...args, harness: "codex" as const },
    { ...args, harness: "codex" as const, credentialId: "not-an-id" },
  ])
    await expect(launchSandbox(transport, { ...chosen, armadaAccess: true })).rejects.toThrow(
      "explicit named Codex account",
    );
  expect(routes).toHaveLength(0);
});

test("a launch answered after 12 seconds is started, not an unanswered request", async () => {
  jest.useFakeTimers();
  try {
    const slow = {
      serverUrl: "https://armada.test/mcp",
      token: "t",
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          setTimeout(() => resolve(Response.json({ sandbox: { id: "s1" } })), 12_000);
        })) as typeof fetch,
    };
    const launched = launchSandbox(slow, args);
    jest.advanceTimersByTime(12_000);
    expect(await launched).toEqual({ id: "s1" });
    expect(LAUNCH_TIMEOUT_MS).toBeGreaterThan(CONTROL_TIMEOUT_MS);
  } finally {
    jest.useRealTimers();
  }
});

const KEY = "22222222-2222-4222-8222-222222222222";
const unanswered = () =>
  new ControlError("The Armada server did not answer in time.", undefined, undefined, { outcomeUnknown: true });

test("a repeated submit of the same choices reuses the request key; a changed choice gets a new one", () => {
  let n = 0;
  const fresh = () => `key-${++n}`;
  const form = (prompt: string): [string, string][] => [
    ["golden", "web"],
    ["prompt", prompt],
  ];
  const first = launchKeyFor(null, form("Say Hello"), fresh);
  const retry = launchKeyFor(first, [...form("Say Hello"), [LAUNCH_KEY_FIELD, first.key]], fresh);
  expect(retry.key).toBe(first.key);
  expect(launchKeyFor(retry, form("Say Goodbye"), fresh).key).not.toBe(first.key);
});

test("a retry of the same request key goes to the sandbox its first attempt created, without launching again", async () => {
  let launches = 0;
  const followed = await followLaunch({
    key: KEY,
    previous: { key: KEY, since: 1_000 },
    now: () => 5_000,
    remember: () => {},
    forget: () => {},
    created: async (since) => (since === 1_000 ? "s1" : null),
    launch: async () => ({ id: `s${++launches + 1}` }),
  });
  expect(followed).toEqual({ state: "started", id: "s1" });
  expect(launches).toBe(0);
});

test("an unanswered launch is followed to the sandbox it started, else reported unknown", async () => {
  const remembered: unknown[] = [];
  const base = {
    key: KEY,
    previous: { key: "33333333-3333-4333-8333-333333333333", since: 1 },
    now: () => 2_000,
    remember: (attempt: unknown) => {
      remembered.push(attempt);
    },
    forget: () => {
      remembered.push("forgotten");
    },
    launch: async () => {
      throw unanswered();
    },
  };
  expect(await followLaunch({ ...base, created: async (since) => (since === 2_000 ? "s1" : null) })).toEqual({
    state: "started",
    id: "s1",
  });
  expect(remembered).toEqual([{ key: KEY, since: 2_000 }]);
  expect(await followLaunch({ ...base, created: async () => null })).toEqual({ state: "unknown", since: 2_000 });
  // A refusal the server answered is not followed: the launch failed and the person fixes its cause.
  const refused = new ControlError("No.", 400);
  const error = await followLaunch({
    ...base,
    created: async () => "s1",
    launch: async () => {
      throw refused;
    },
  }).catch((e) => e);
  expect(error).toBe(refused);
  // The refused attempt is forgotten: the next submission of the same choices launches again.
  expect(remembered.at(-1)).toBe("forgotten");
});

test("a retry after a refusal the server answered launches again under the same key", async () => {
  let previous: { key: string; since: number } | null = null;
  let launches = 0;
  const deps = {
    key: KEY,
    now: () => 1_000 + launches,
    remember: (attempt: { key: string; since: number }) => {
      previous = attempt;
    },
    forget: () => {
      previous = null;
    },
    // The refused attempt left only a failed row, which the live lookup does not return.
    created: async () => null,
    launch: async () => {
      launches += 1;
      if (launches === 1) throw new ControlError("The provider refused.", 409);
      return { id: "s2" };
    },
  };
  await followLaunch({ ...deps, previous }).catch(() => {});
  expect(previous).toBeNull();
  expect(await followLaunch({ ...deps, previous })).toEqual({ state: "started", id: "s2" });
  expect(launches).toBe(2);
});

test("the launch attempt cookie round-trips and refuses anything else", () => {
  expect(decodeLaunchAttempt(encodeLaunchAttempt({ key: KEY, since: 42 }))).toEqual({ key: KEY, since: 42 });
  for (const bad of [undefined, "", "x.42", `${KEY}.0`, `${KEY}.42.1`, `${KEY}.nope`])
    expect(decodeLaunchAttempt(bad)).toBeNull();
});

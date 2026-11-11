import { expect, test } from "bun:test";
import { SIZED_LAUNCH_ROUTE_V1 } from "@armada/core";
import { ControlError } from "../src/lib/control.ts";
import { launchSandbox } from "../src/lib/launch.ts";

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

import { expect, test } from "bun:test";
import { ControlError, createControlClient, readGoldenCapabilities } from "../src/lib/control.ts";

const TOKEN = "session-token-under-test";

test("posts once to the control API origin with the bearer, and returns the JSON", async () => {
  const seen: Request[] = [];
  const client = createControlClient({
    serverUrl: "https://armada.test/mcp",
    token: TOKEN,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return Response.json({ name: "web", visibility: "org", snapshot: "golden-1" });
    }) as typeof fetch,
  });
  expect(await client.post("golden/create", { name: "web" })).toEqual({
    name: "web",
    visibility: "org",
    snapshot: "golden-1",
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("https://armada.test/api/v1/golden/create");
  expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(await seen[0]?.json()).toEqual({ name: "web" });
});

test("a refusal carries the server's message and code, never the token, and is not retried", async () => {
  let calls = 0;
  const client = createControlClient({
    serverUrl: "https://armada.test/mcp",
    token: TOKEN,
    fetch: (async () => {
      calls += 1;
      return Response.json(
        { error: { code: "conflict", message: "This backend has reached its golden capacity." } },
        { status: 409 },
      );
    }) as unknown as typeof fetch,
  });
  const error = await client.post("golden/create", {}).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ControlError);
  expect(error).toMatchObject({
    status: 409,
    code: "conflict",
    message: "This backend has reached its golden capacity.",
  });
  expect(String((error as Error).message)).not.toContain(TOKEN);
  expect(calls).toBe(1);
});

test("an unreachable or unconfigured server is a plain message", async () => {
  const down = createControlClient({
    serverUrl: "https://armada.test/mcp",
    token: TOKEN,
    fetch: (async () => {
      throw new TypeError(`connect failed ${TOKEN}`);
    }) as unknown as typeof fetch,
  });
  await expect(down.post("golden/update", {})).rejects.toThrow("The Armada server is unreachable.");
  const unset = createControlClient({ serverUrl: "not a url", token: TOKEN });
  await expect(unset.post("golden/update", {})).rejects.toThrow("not configured");
});

function answering(status: number, body: unknown, seen: Request[] = []) {
  return createControlClient({
    serverUrl: "https://armada.test/mcp",
    token: TOKEN,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return Response.json(body, { status });
    }) as typeof fetch,
  });
}

test("the golden limit is read once from golden/capabilities for the selected org and Boat", async () => {
  const seen: Request[] = [];
  const org = "00000000-0000-4000-8000-000000000010";
  expect(await readGoldenCapabilities(answering(200, { provider: "boat", maxGoldens: 1 }, seen), org)).toEqual({
    ok: true,
    maxGoldens: 1,
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("https://armada.test/api/v1/golden/capabilities");
  expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(await seen[0]?.json()).toEqual({ org, provider: "boat" });
  // Null is "no limit reported", not zero and not a default.
  expect(await readGoldenCapabilities(answering(200, { provider: "boat", maxGoldens: null }), org)).toEqual({
    ok: true,
    maxGoldens: null,
  });
});

test("a refused, failed or unexpected capacity read is unavailable, never a number, and is not retried", async () => {
  const org = "00000000-0000-4000-8000-000000000011";
  const seen: Request[] = [];
  const foreign = answering(403, { error: { code: "forbidden", message: "You are not a member of this org." } }, seen);
  expect(await readGoldenCapabilities(foreign, org)).toEqual({
    ok: false,
    reason: "You are not a member of this org.",
  });
  expect(seen).toHaveLength(1);
  const noKey = answering(503, { error: { code: "unavailable", message: "No Boat credential for this org." } });
  expect(await readGoldenCapabilities(noKey, org)).toEqual({ ok: false, reason: "No Boat credential for this org." });
  // An older server without the route.
  for (const body of [{ error: "Not found." }, null])
    expect(await readGoldenCapabilities(answering(404, body), org)).toEqual({
      ok: false,
      reason: "This Armada server does not report golden capacity yet.",
    });
  for (const body of [{ provider: "modal", maxGoldens: 1 }, { provider: "boat", maxGoldens: 0 }, { provider: "boat" }])
    expect(await readGoldenCapabilities(answering(200, body), org)).toEqual({
      ok: false,
      reason: "The Armada server sent an unexpected answer.",
    });
  const down = createControlClient({
    serverUrl: "https://armada.test/mcp",
    token: TOKEN,
    fetch: (async () => {
      throw new TypeError(`connect failed ${TOKEN}`);
    }) as unknown as typeof fetch,
  });
  const unreachable = await readGoldenCapabilities(down, org);
  expect(unreachable).toEqual({ ok: false, reason: "The Armada server is unreachable." });
  expect(JSON.stringify(unreachable)).not.toContain(TOKEN);
});

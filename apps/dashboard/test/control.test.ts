import { expect, test } from "bun:test";
import { ControlError, createControlClient } from "../src/lib/control.ts";
import { boatGoldenCapacity } from "../src/lib/data/golden-capacity.ts";

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

test("the Boat capacity comes from the provider adapter's own export, without a network call", () => {
  expect(boatGoldenCapacity()).toBe(1);
});

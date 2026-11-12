import { expect, spyOn, test } from "bun:test";
import { ControlError, controlPost, createControlClient, readGoldenCapabilities } from "../src/lib/control.ts";

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
  expect(seen[0]?.redirect).toBe("error");
  expect(seen[0]?.cache).toBe("no-store");
  expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
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

test("the golden limit is read once from golden/capabilities for the selected org and the asked provider", async () => {
  const seen: Request[] = [];
  const org = "00000000-0000-4000-8000-000000000010";
  expect(await readGoldenCapabilities(answering(200, { provider: "boat", maxGoldens: 1 }, seen), org, "boat")).toEqual({
    ok: true,
    maxGoldens: 1,
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("https://armada.test/api/v1/golden/capabilities");
  expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(await seen[0]?.json()).toEqual({ org, provider: "boat" });
  // Null is "no limit reported", not zero and not a default: Modal is unbounded.
  const modalSeen: Request[] = [];
  expect(
    await readGoldenCapabilities(answering(200, { provider: "modal", maxGoldens: null }, modalSeen), org, "modal"),
  ).toEqual({ ok: true, maxGoldens: null });
  expect(await modalSeen[0]?.json()).toEqual({ org, provider: "modal" });
  // An answer about another provider is not this provider's limit.
  expect(await readGoldenCapabilities(answering(200, { provider: "boat", maxGoldens: 1 }), org, "modal")).toEqual({
    ok: false,
    reason: "The Armada server sent an unexpected answer.",
  });
});

test("a refused, failed or unexpected capacity read is unavailable, never a number, and is not retried", async () => {
  const org = "00000000-0000-4000-8000-000000000011";
  const seen: Request[] = [];
  const foreign = answering(403, { error: { code: "forbidden", message: "You are not a member of this org." } }, seen);
  expect(await readGoldenCapabilities(foreign, org, "boat")).toEqual({
    ok: false,
    reason: "You are not a member of this org.",
  });
  expect(seen).toHaveLength(1);
  const noKey = answering(503, { error: { code: "unavailable", message: "No Boat credential for this org." } });
  expect(await readGoldenCapabilities(noKey, org, "boat")).toEqual({
    ok: false,
    reason: "No Boat credential for this org.",
  });
  // An older server without the route.
  for (const body of [{ error: "Not found." }, null])
    expect(await readGoldenCapabilities(answering(404, body), org, "boat")).toEqual({
      ok: false,
      reason: "This Armada server does not report golden capacity yet.",
    });
  for (const body of [{ provider: "modal", maxGoldens: 1 }, { provider: "boat", maxGoldens: 0 }, { provider: "boat" }])
    expect(await readGoldenCapabilities(answering(200, body), org, "boat")).toEqual({
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
  const unreachable = await readGoldenCapabilities(down, org, "boat");
  expect(unreachable).toEqual({ ok: false, reason: "The Armada server is unreachable." });
  expect(JSON.stringify(unreachable)).not.toContain(TOKEN);
});

// Both public adapter boundaries own deadline behavior; feature callers need no duplicate cases.
for (const adapter of ["client", "controlPost"] as const) {
  const post = (options: Parameters<typeof createControlClient>[0]) =>
    adapter === "client"
      ? createControlClient(options).post("golden/create", {})
      : controlPost(options, "/api/v1/launch", {});

  test(`${adapter}: fetch and body aborts report an unknown outcome without retrying or leaking the bearer`, async () => {
    for (const phase of ["fetch", "body", "stalled body"] as const) {
      const controller = new AbortController();
      const deadline = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      let calls = 0;
      try {
        const result = post({
          serverUrl: "https://armada.test/mcp",
          token: TOKEN,
          timeoutMs: 1234,
          fetch: (async (_input, init) => {
            calls++;
            expect(init?.signal).toBe(controller.signal);
            if (phase === "fetch") throw new DOMException(TOKEN, "AbortError");
            return {
              status: 200,
              ok: true,
              json: async () => {
                if (phase === "body") throw new DOMException(TOKEN, "AbortError");
                queueMicrotask(() => controller.abort(new DOMException(TOKEN, "TimeoutError")));
                return new Promise(() => {});
              },
            } as Response;
          }) as typeof fetch,
        }).catch((error: unknown) => error);
        const error = await result;
        expect(error).toBeInstanceOf(ControlError);
        expect((error as Error).message).toContain("outcome may be unknown");
        expect((error as Error).message).toContain("inspect its status");
        expect((error as Error).message).not.toContain(TOKEN);
        expect((error as Error).message).not.toContain("build");
        expect(calls).toBe(1);
        expect(deadline).toHaveBeenCalledWith(1234);
      } finally {
        deadline.mockRestore();
      }
    }
  });

  test(`${adapter}: refuses unsafe origins and invalid deadlines before sending a bearer`, async () => {
    let calls = 0;
    const options = {
      serverUrl: "https://armada.test/mcp",
      token: TOKEN,
      fetch: (async () => {
        calls++;
        return Response.json({});
      }) as typeof fetch,
    };
    for (const serverUrl of ["not a url", "ftp://armada.test", "https://user:password@armada.test"])
      await expect(post({ ...options, serverUrl })).rejects.toThrow("not configured");
    for (const timeoutMs of [NaN, Infinity, 0, -1, 0.5, 2_147_483_648])
      await expect(post({ ...options, timeoutMs })).rejects.toThrow("deadline");
    expect(calls).toBe(0);
  });
}

test("the generic client retains arbitrary JSON and its own refusal mappings", async () => {
  for (const value of [null, ["value"], 42, "text"])
    expect(await answering(200, value).post("read", {})).toEqual(value);
  const malformed = createControlClient({
    serverUrl: "https://armada.test",
    token: TOKEN,
    fetch: (async () => new Response("not JSON")) as typeof fetch,
  });
  expect(await malformed.post("read", {})).toBeNull();
  for (const status of [401, 404, 405]) {
    const error = await answering(status, { error: { code: "missing", message: "Domain refusal." } })
      .post("read", {})
      .catch((error: unknown) => error);
    expect(error).toMatchObject(
      status === 401
        ? { status, message: "The Armada server refused this session. Sign in again.", code: undefined }
        : { status, message: "Domain refusal.", code: "missing" },
    );
  }
});

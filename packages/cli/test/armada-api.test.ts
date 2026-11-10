import { describe, expect, test } from "bun:test";
import { armadaApiUrl, createArmadaApiClient } from "../src/armada-api.ts";
import { memorySessionStore } from "../src/session.ts";

const token = "secret-token-that-must-not-leak";

function io(env: NodeJS.ProcessEnv = {}) {
  return {
    env,
    session: memorySessionStore({
      accessToken: "saved-session-token",
      refreshToken: "refresh",
      expiresAt: "2099-01-01T00:00:00.000Z",
      armadaUrl: "https://saved.armada.test",
    }),
    fetch: (async () => Response.json({ ok: true })) as unknown as typeof fetch,
  };
}

describe("Armada API client", () => {
  test("uses --url over ARMADA_URL and the saved session", async () => {
    const calls: Request[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push(new Request(String(input), init));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const client = await createArmadaApiClient(
      { ...io({ ARMADA_URL: "https://environment.armada.test", ARMADA_TOKEN: token }), fetch: fetchImpl },
      { url: "https://flag.armada.test" },
    );
    await client.request("/api/v1/example");
    expect(calls[0]?.url).toBe("https://flag.armada.test/api/v1/example");
  });

  test("prefers ARMADA_TOKEN and works without a saved session", async () => {
    let authorization = "";
    const state = io({ ARMADA_TOKEN: token });
    state.session = memorySessionStore();
    state.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const client = await createArmadaApiClient(state);
    await client.request("/healthz");
    expect(authorization).toBe(`Bearer ${token}`);
  });

  test("does not make provider URLs valid API origins", () => {
    expect(() => armadaApiUrl("https://project.supabase.co/rest/v1")).toThrow("HTTP(S) Armada API URL");
    expect(() => armadaApiUrl("https://user:pass@armada.test")).toThrow("HTTP(S) Armada API URL");
  });

  test("maps a 401 without exposing the token", async () => {
    const client = await createArmadaApiClient({
      ...io({ ARMADA_TOKEN: token }),
      fetch: (async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
    });
    try {
      await client.request("/api/v1/example");
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("Run armada login");
      expect(String(error)).not.toContain(token);
    }
  });
});

describe("API client origin and session safety", () => {
  test("does not read a malformed saved session when ARMADA_TOKEN is set", async () => {
    let reads = 0;
    const client = await createArmadaApiClient({
      env: { ARMADA_TOKEN: token },
      session: {
        read: async () => {
          reads += 1;
          throw new Error("stale session must not be read");
        },
        write: async () => undefined,
        clear: async () => undefined,
      },
      fetch: async () => Response.json({ ok: true }),
    });
    await client.request("/api/v1/golden/list");
    expect(reads).toBe(0);
  });

  test("refuses protocol-relative and backslash paths that escape the API origin", async () => {
    const client = await createArmadaApiClient({
      ...io({ ARMADA_TOKEN: token }),
      fetch: async () => Response.json({}),
    });
    await expect(client.request("//evil.example/steal")).rejects.toThrow("stay on the Armada origin");
    await expect(client.request("/\\evil.example/steal")).rejects.toThrow("stay on the Armada origin");
  });
});

test("API calls leave the explicit signal as the only client-side deadline", async () => {
  const controller = new AbortController();
  let options: RequestInit | undefined;
  const client = await createArmadaApiClient({
    ...io({ ARMADA_TOKEN: token }),
    fetch: async (_input, init) => {
      options = init;
      return Response.json({ ok: true });
    },
  });
  await client.request("/api/v1/golden/create", { method: "POST", signal: controller.signal });
  expect(options).toMatchObject({ signal: controller.signal, timeout: false });
});

test("request cancellation also cancels saved-session refresh, preserving optional advice deadlines", async () => {
  const controller = new AbortController();
  let refreshAborted = false;
  let calls = 0;
  const client = await createArmadaApiClient({
    ...io({}),
    fetch: async (_input, init) => {
      calls++;
      if (calls === 1) {
        controller.abort();
        return new Response(null, { status: 401 });
      }
      refreshAborted = init?.signal?.aborted === true;
      init?.signal?.throwIfAborted();
      throw new Error("refresh must inherit cancellation");
    },
  });
  await expect(client.request("/api/v1/sandbox/advice", { signal: controller.signal })).rejects.toThrow(
    "could not reach",
  );
  expect(calls).toBe(2);
  expect(refreshAborted).toBe(true);
});

// API transport owns redaction; server payloads must not become terminal output.
for (const path of [
  "sandbox/detail",
  "sandbox/status",
  "sandbox/send",
  "sandbox/exec",
  "sandbox/stop",
  "logs/read",
  "mcp/sandbox-connections",
]) {
  for (const status of [403, 404, 500]) {
    test(`${path} ${status} never relays raw interior failures`, async () => {
      const client = await createArmadaApiClient({
        ...io({ ARMADA_TOKEN: token }),
        fetch: (async () =>
          Response.json({ error: { message: `upstream ${token}` } }, { status })) as unknown as typeof fetch,
      });
      try {
        await client.request(`/api/v1/${path}`);
        throw new Error("expected rejection");
      } catch (error) {
        expect(String(error)).not.toContain(token);
        expect(String(error)).not.toContain("upstream");
        expect(String(error)).toContain(
          status === 403
            ? "owner or an org admin"
            : status === 404
              ? "not accessible"
              : "Check access and sandbox status",
        );
      }
    });
  }
}
test("a long-lived client uses the rotated refresh token on later requests and preserves retry keys", async () => {
  const session = memorySessionStore({
    accessToken: "access-0",
    refreshToken: "refresh-0",
    expiresAt: "2000-01-01T00:00:00Z",
  });
  const refreshes: string[] = [];
  const keys: (string | null)[] = [];
  let reads = 0;
  const client = await createArmadaApiClient({
    env: {},
    session,
    fetch: async (_input, init) => {
      if (String(_input).endsWith("/api/v1/auth/refresh")) {
        refreshes.push(JSON.parse(String(init?.body)).refreshToken);
        const n = refreshes.length;
        return Response.json({
          accessToken: `access-${n}`,
          refreshToken: `refresh-${n}`,
          expiresAt: "2099-01-01T00:00:00Z",
        });
      }
      keys.push(new Headers(init?.headers).get("idempotency-key"));
      return ++reads === 1 ? Response.json({}, { status: 401 }) : Response.json({ ok: true });
    },
  });
  expect(
    await client.request<{ ok: boolean }>("/api/v1/orchestrators/id/resume", {
      method: "POST",
      headers: { "idempotency-key": "original" },
      body: "{}",
    }),
  ).toEqual({ ok: true });
  expect(refreshes).toEqual(["refresh-0", "refresh-1"]);
  expect(keys).toEqual(["original", "original"]);
  expect((await session.read())?.refreshToken).toBe("refresh-2");
});

for (const failure of ["502", "network"] as const) {
  test(`lost launch outcome (${failure}) advises checking without echoing server text`, async () => {
    const state = io({ ARMADA_TOKEN: token });
    state.fetch = (async () => {
      if (failure === "network") throw Error(token);
      return Response.json({ error: { message: token } }, { status: 502 });
    }) as unknown as typeof fetch;
    const client = await createArmadaApiClient(state);
    await expect(client.request("/api/v1/sandbox/launch", { method: "POST" })).rejects.toThrow(
      "Launch outcome unknown. Run armada list to check before retrying.",
    );
  });
}

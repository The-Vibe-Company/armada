import { describe, expect, test } from "bun:test";
import { memorySessionStore } from "@armada/auth";
import { armadaApiUrl, createArmadaApiClient } from "../src/armada-api.ts";

const token = "secret-token-that-must-not-leak";

function io(env: NodeJS.ProcessEnv = {}) {
  return {
    env,
    session: memorySessionStore({
      userId: "user",
      accessToken: "saved-session-token",
      refreshToken: "refresh",
      expiresAt: "2099-01-01T00:00:00.000Z",
      supabaseUrl: "https://not-an-api.example",
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

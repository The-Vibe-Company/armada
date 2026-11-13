import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArmadaApiError, armadaApiUrl, createArmadaApiClient } from "../src/armada-api.ts";
import { fileSessionStore, memorySessionStore } from "../src/session.ts";

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
  "sandbox/extend",
  "logs/read",
  "mcp/sandbox-connections",
]) {
  for (const status of [403, 404, 500]) {
    test(`${path} ${status} never relays raw interior failures`, async () => {
      const client = await createArmadaApiClient({
        ...io({ ARMADA_TOKEN: token }),
        fetch: (async () =>
          Response.json(
            { error: { code: status === 404 ? "not_found" : "unavailable", message: `upstream ${token}` } },
            { status },
          )) as unknown as typeof fetch,
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
    await client.request<{ ok: boolean }>("/api/v1/sandbox/resume", {
      method: "POST",
      headers: { "idempotency-key": "original" },
      body: "{}",
    }),
  ).toEqual({ ok: true });
  expect(refreshes).toEqual(["refresh-0", "refresh-1"]);
  expect(keys).toEqual(["original", "original"]);
  expect((await session.read())?.refreshToken).toBe("refresh-2");
});

for (const failure of ["502", "network", "timeout"] as const) {
  test(`lost launch outcome (${failure}) advises checking without echoing server text`, async () => {
    const state = io({ ARMADA_TOKEN: token });
    state.fetch = (async () => {
      if (failure === "network") throw Error(token);
      if (failure === "timeout") throw new DOMException(token, "TimeoutError");
      return Response.json({ error: { message: token } }, { status: 502 });
    }) as unknown as typeof fetch;
    const client = await createArmadaApiClient(state);
    await expect(client.request("/api/v1/sandbox/launch", { method: "POST" })).rejects.toThrow(
      "Run armada list to check before retrying.",
    );
  });
}

for (const path of ["launch", "launch-sized-v1", "launch-access-v1"]) {
  for (const [status, code] of [
    [429, "rate_limited"],
    [402, "payment_required"],
  ] as const) {
    test(`known allocation refusal keeps its code and closed help (${path}, ${code})`, async () => {
      const client = await createArmadaApiClient({
        ...io({ ARMADA_TOKEN: token }),
        fetch: async () =>
          Response.json(
            {
              error: {
                code,
                message: token,
                details: {
                  provider: "boat",
                  window: "day",
                  nextStartAt: "2026-11-12T08:08:00.000Z",
                },
              },
            },
            { status },
          ),
      });
      try {
        await client.request(`/api/v1/sandbox/${path}`, { method: "POST" });
        throw Error("Expected refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(ArmadaApiError);
        expect((error as ArmadaApiError).serverCode).toBe(code);
        expect((error as Error).message).not.toContain(token);
        expect((error as Error).message).not.toContain("outcome unknown");
        if (code === "rate_limited") {
          expect((error as Error).message).toContain("plan start limit per day");
          expect((error as Error).message).toContain("2026-11-12T08:08:00.000Z");
        }
      }
    });
  }
}

test("closed server failures give actionable CLI help without parsing free text", async () => {
  for (const [code, status, help] of [
    ["github_hydration_failed", 503, "Check the failing phase"],
    ["credential_refused", 422, "Replace or reconnect"],
    ["provider_unavailable", 502, "Try again later"],
    ["dependency_unavailable", 503, "Try again later"],
    ["outcome_unknown", 503, "Check its status before retrying"],
  ] as const) {
    const client = await createArmadaApiClient({
      ...io({ ARMADA_TOKEN: token }),
      fetch: async () => Response.json({ error: { code, message: "credential_refused revoked expired" } }, { status }),
    });
    try {
      await client.request(code === "github_hydration_failed" ? "/api/v1/github/refresh" : "/api/v1/sandbox/launch");
      throw new Error("Expected error");
    } catch (error) {
      expect(error).toBeInstanceOf(ArmadaApiError);
      expect((error as ArmadaApiError).serverCode).toBe(code);
      expect((error as Error).message).toContain(help);
    }
  }
});

// The CLI owns distrust of response diagnostics, including structured phase values.
test("GitHub repair exposes only a closed server phase to its owner", async () => {
  for (const phase of ["sudo", "directories", "synthetic-secret", null]) {
    const client = await createArmadaApiClient({
      ...io({ ARMADA_TOKEN: token }),
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "github_hydration_failed",
              message: "synthetic-secret",
              details: { phase, raw: "synthetic-secret" },
            },
          },
          { status: 503 },
        ),
    });
    try {
      await client.request("/api/v1/github/refresh");
      throw Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ArmadaApiError);
      const failure = error as ArmadaApiError;
      expect(failure.serverCode).toBe("github_hydration_failed");
      expect(failure.details).toEqual(phase === "sudo" || phase === "directories" ? { phase } : undefined);
      if (failure.details) expect(failure.message).toContain(`Failing phase: ${phase}.`);
      expect(JSON.stringify(error)).not.toContain("synthetic-secret");
      expect(failure.message).not.toContain("synthetic-secret");
    }
  }
});

for (const armadaUrl of [undefined, "https://armada.thevibecompany.co/"]) {
  test(`independent CLI stores reuse a concurrent refresh (${armadaUrl ? "bound" : "legacy"} session)`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "armada-refresh-"));
    try {
      const path = join(directory, "session.json");
      const firstStore = fileSessionStore(path);
      const secondStore = fileSessionStore(path);
      await firstStore.write({
        loginId: "same-login",
        accessToken: "access-old",
        refreshToken: "refresh-old",
        expiresAt: "2000-01-01",
        ...(armadaUrl ? { armadaUrl } : {}),
      });
      let reads = 0;
      let bothRead!: () => void;
      const bothLoaded = new Promise<void>((resolve) => {
        bothRead = resolve;
      });
      const commandStore = (store: typeof firstStore) => ({
        ...store,
        read: async () => {
          const saved = await store.read();
          if (++reads === 2) bothRead();
          return saved;
        },
      });
      let refreshes = 0;
      const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
        if (String(_input).endsWith("/auth/refresh")) {
          await bothLoaded;
          refreshes++;
          expect(JSON.parse(String(init?.body)).refreshToken).toBe("refresh-old");
          if (refreshes > 1) return Response.json({}, { status: 401 });
          return Response.json({ accessToken: "access-new", refreshToken: "refresh-new", expiresAt: "2099-01-01" });
        }
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-new");
        return Response.json({ ok: true });
      };
      const [first, other] = await Promise.all([
        createArmadaApiClient({ env: {}, session: commandStore(firstStore), fetch }),
        createArmadaApiClient({ env: {}, session: commandStore(secondStore), fetch }),
      ]);
      await Promise.all([first.request("/api/v1/example"), other.request("/api/v1/example")]);
      expect(refreshes).toBe(1);
      expect(await secondStore.read()).toMatchObject({ refreshToken: "refresh-new", loginId: "same-login" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("a stale client refreshes an expired rotated winner before retrying its request", async () => {
  const state = io();
  const initial = await state.session.read();
  if (!initial) throw new Error("Missing fixture session");
  let refreshes = 0;
  let requests = 0;
  state.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).endsWith("/auth/refresh")) {
      refreshes++;
      expect(JSON.parse(String(init?.body)).refreshToken).toBe("refresh-rotated");
      return Response.json({ accessToken: "usable-access", refreshToken: "next-refresh", expiresAt: "2099-01-01" });
    }
    requests++;
    if (new Headers(init?.headers).get("authorization") !== "Bearer usable-access")
      return Response.json({}, { status: 401 });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const client = await createArmadaApiClient(state);
  await state.session.write({
    ...initial,
    accessToken: "expired-rotated",
    refreshToken: "refresh-rotated",
    expiresAt: "2000-01-01",
  });
  await expect(client.request("/api/v1/example")).resolves.toEqual({ ok: true });
  expect(refreshes).toBe(1);
  expect(requests).toBe(2);
});

test("a pending request never switches to a replacement login at the same origin", async () => {
  const state = io();
  const initial = await state.session.read();
  if (!initial) throw new Error("Missing fixture session");
  await state.session.write({ ...initial, loginId: "original-login" });
  let calls = 0;
  state.fetch = (async () => {
    calls++;
    return Response.json({}, { status: 401 });
  }) as unknown as typeof fetch;
  const client = await createArmadaApiClient(state);
  const replacement = {
    ...initial,
    loginId: "replacement-login",
    accessToken: "other-account",
    refreshToken: "other-refresh",
  };
  await state.session.write(replacement);
  await expect(client.request("/api/v1/example")).rejects.toThrow("saved login changed");
  expect(calls).toBe(1);
  expect(await state.session.read()).toEqual(replacement);
});

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { browserLogin } from "../src/browser-login.ts";

test("browser login uses randomized PKCE and state, rejects a bad callback, then exchanges only the good callback code", async () => {
  let resolveOpened!: (url: string) => void;
  const opened = new Promise<string>((resolve) => {
    resolveOpened = resolve;
  });
  let exchange: { url: string; init?: RequestInit } | undefined;
  const login = browserLogin({
    origin: "https://armada.example",
    provider: "github",
    timeoutMs: 1_000,
    open: (url) => {
      resolveOpened(url);
    },
    fetch: (async (input, init) => {
      exchange = { url: String(input), ...(init === undefined ? {} : { init }) };
      return Response.json({ accessToken: "access", refreshToken: "refresh", expiresAt: "2099-01-01T00:00:00.000Z" });
    }) as typeof fetch,
  });

  const authorize = new URL(await opened);
  expect(authorize.origin).toBe("https://armada.example");
  expect(authorize.pathname).toBe("/api/v1/auth/authorize");
  expect(authorize.searchParams.get("provider")).toBe("github");
  const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  expect(callback.protocol).toBe("http:");
  expect(callback.hostname).toBe("127.0.0.1");
  expect(callback.port).not.toBe("");
  expect(callback.pathname).toBe("/callback");
  expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  expect(authorize.searchParams.get("state")).toMatch(/^[a-f0-9]{32}$/);

  const outcome = login.then(
    () => undefined,
    (error: unknown) => error,
  );
  const rejected = await fetch(`${callback}?code=wrong&state=wrong`);
  expect(rejected.status).toBe(400);
  await expect(outcome).resolves.toThrow("Login callback was refused.");
  expect(exchange).toBeUndefined();
});

test("browser login exchanges a valid state-bound callback code with its PKCE verifier", async () => {
  let resolveOpened!: (url: string) => void;
  const opened = new Promise<string>((resolve) => {
    resolveOpened = resolve;
  });
  const login = browserLogin({
    origin: "https://armada.example",
    provider: "google",
    timeoutMs: 1_000,
    open: (url) => {
      resolveOpened(url);
    },
    fetch: (async (input, init) => {
      expect(String(input)).toBe("https://armada.example/api/v1/auth/exchange");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      const body = (await new Request(String(input), init).json()) as Record<string, string>;
      expect(body.code).toBe("authorization-code");
      expect(body.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      expect(createHash("sha256").update(body.verifier ?? "").digest("base64url")).toBe(
        new URL(await opened).searchParams.get("code_challenge") ?? "",
      );
      return Response.json({ accessToken: "access", refreshToken: "refresh", expiresAt: "2099-01-01T00:00:00.000Z" });
    }) as typeof fetch,
  });
  const outcome = login.then(
    (session) => session,
    (error: unknown) => error,
  );
  const authorize = new URL(await opened);
  const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  const response = await fetch(`${callback}?code=authorization-code&state=${authorize.searchParams.get("state")}`);
  expect(response.status).toBe(200);
  await expect(outcome).resolves.toEqual({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
});

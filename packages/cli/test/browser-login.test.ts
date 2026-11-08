import { expect, test } from "bun:test";
import { browserLogin } from "../src/browser-login.ts";

test("browser login uses randomized PKCE and state, rejects a bad callback, then exchanges only the good callback code", async () => {
  let opened = "";
  let exchange: { url: string; init?: RequestInit } | undefined;
  const login = browserLogin({
    origin: "https://armada.example",
    provider: "github",
    timeoutMs: 1_000,
    open: (url) => {
      opened = url;
    },
    fetch: (async (input, init) => {
      exchange = { url: String(input), ...(init === undefined ? {} : { init }) };
      return Response.json({ accessToken: "access", refreshToken: "refresh", expiresAt: "2099-01-01T00:00:00.000Z" });
    }) as typeof fetch,
  });
  for (let attempt = 0; !opened && attempt < 20; attempt += 1) await Bun.sleep(1);

  const authorize = new URL(opened);
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

  const rejected = await fetch(`${callback}?code=wrong&state=wrong`);
  expect(rejected.status).toBe(400);
  await expect(login).rejects.toThrow("Login callback was refused.");
  expect(exchange).toBeUndefined();
});

test("browser login exchanges a valid state-bound callback code with its PKCE verifier", async () => {
  let opened = "";
  let resolveExchange!: () => void;
  const exchanged = new Promise<void>((resolve) => {
    resolveExchange = resolve;
  });
  const login = browserLogin({
    origin: "https://armada.example",
    provider: "google",
    timeoutMs: 1_000,
    open: (url) => {
      opened = url;
    },
    fetch: (async (input, init) => {
      expect(String(input)).toBe("https://armada.example/api/v1/auth/exchange");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      const body = (await new Request(String(input), init).json()) as Record<string, string>;
      expect(body.code).toBe("authorization-code");
      expect(body.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      resolveExchange();
      return Response.json({ accessToken: "access", refreshToken: "refresh", expiresAt: "2099-01-01T00:00:00.000Z" });
    }) as typeof fetch,
  });
  for (let attempt = 0; !opened && attempt < 20; attempt += 1) await Bun.sleep(1);
  const authorize = new URL(opened);
  const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  const response = await fetch(`${callback}?code=authorization-code&state=${authorize.searchParams.get("state")}`);
  expect(response.status).toBe(200);
  await exchanged;
  await expect(login).resolves.toEqual({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
});

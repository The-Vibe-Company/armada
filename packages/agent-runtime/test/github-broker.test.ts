import { expect, test } from "bun:test";
import { GitHubBroker } from "../src/github-broker.ts";

test("late acquisition cannot publish across replacement/scrub and retired values stay registered", async () => {
  let deliver!: (value: Response) => void;
  const response = new Promise<Response>((resolve) => {
    deliver = resolve;
  });
  const values = new Set<string>();
  const broker = new GitHubBroker(
    (items) => {
      for (const item of items) values.add(item);
    },
    (() => response) as unknown as typeof fetch,
    () => 100,
  );
  broker.configure({
    version: 1,
    revision: "1",
    generation: "one",
    url: "https://armada.example/api/internal/github/credentials",
    capability: `armada_gh_${"a".repeat(64)}`,
    expiresAt: 200,
  });
  const pending = broker.acquire("acme/repo", "git");
  broker.configure(null);
  const token = `offline-${crypto.randomUUID()}`;
  deliver(Response.json({ token }));
  await expect(pending).rejects.toThrow("github_credentials_denied");
  expect(values.has(token)).toBe(true);
  await expect(broker.acquire("acme/repo", "git")).rejects.toThrow("github_credentials_denied");
});

test("acquisition failures identify their boundary without exposing upstream text", async () => {
  for (const [response, code] of [
    [new Response("private_upstream_detail", { status: 403 }), "http_denied"],
    [new Response("private_upstream_detail", { status: 502 }), "http_unavailable"],
    [new Response("private_upstream_detail"), "invalid_json"],
    [Response.json(null), "invalid_token"],
    [Response.json({ token: "" }), "invalid_token"],
    [new Response("x".repeat(16385)), "oversized"],
  ] as const) {
    const broker = new GitHubBroker(
      () => {},
      (async () => response) as unknown as typeof fetch,
      () => 100,
    );
    broker.configure({
      version: 1,
      revision: "1",
      generation: "one",
      url: "https://armada.example/api/runtime/github/credentials",
      capability: `armada_gh_${"a".repeat(64)}`,
      expiresAt: 200,
    });
    const error = await broker.acquire("acme/repo", "gh").catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`github_credentials_${code}`);
  }
});

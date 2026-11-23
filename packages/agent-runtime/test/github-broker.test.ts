import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("concurrent broker starts share a live credentials socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-broker-"));
  const broker = new GitHubBroker(
    () => {},
    fetch,
    () => 100,
  );
  const repositories = ["acme/first", "acme/second"];
  broker.configure({
    version: 1,
    revision: "1",
    generation: "one",
    url: "https://armada.example/api/runtime/github/credentials",
    capability: `armada_gh_${"a".repeat(64)}`,
    expiresAt: 200,
    repositories,
  });
  const starts = await Promise.allSettled([broker.listen(root), broker.listen(root)]);
  try {
    const [first, second] = starts;
    if (first.status === "rejected") throw first.reason;
    if (second.status === "rejected") throw second.reason;
    const activate = await fetch("http://broker/activate", {
      unix: first.value.socket,
      method: "POST",
      body: JSON.stringify({ key: first.value.activation }),
    });
    expect(activate.status).toBe(200);
    await activate.body?.cancel();
    for (const unix of [second.value.socket, second.value.redactSocket]) {
      const response = await fetch("http://broker/repositories", { unix, method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ repositories });
    }
  } finally {
    for (const start of starts) if (start.status === "fulfilled") start.value.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed credentials bind releases the redaction socket before a retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-broker-"));
  const broker = new GitHubBroker(() => {});
  const credentials = join(root, "credentials.sock");
  const redact = join(root, "redact.sock");
  try {
    await mkdir(credentials);
    await expect(broker.listen(root)).rejects.toThrow();
    await expect(lstat(redact)).rejects.toHaveProperty("code", "ENOENT");
    await rm(credentials, { recursive: true });
    const listener = await broker.listen(root);
    try {
      const response = await fetch("http://broker/repositories", { unix: listener.redactSocket, method: "POST" });
      expect(response.status).toBe(200);
      await response.body?.cancel();
    } finally {
      listener.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

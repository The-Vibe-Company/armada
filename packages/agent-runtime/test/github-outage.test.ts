import { expect, test } from "bun:test";
import { GitHubBroker } from "../src/github-broker.ts";

// Own upstream-outage refusal and recovery without installing wrappers or spawning native peers.
test("broker sanitizes upstream outage and recovers without serving a stale credential", async () => {
  let unavailable = false;
  let token = "offline_first";
  const registered = new Set<string>();
  const broker = new GitHubBroker(
    (values) => {
      for (const value of values) registered.add(value);
    },
    (async () => {
      if (unavailable) throw Error("upstream_private_diagnostic");
      return Response.json({ token });
    }) as unknown as typeof fetch,
    () => 100,
  );
  broker.configure({
    version: 1,
    revision: "1",
    generation: "offline",
    url: "https://armada.example/api/internal/github/credentials",
    capability: `armada_gh_${"a".repeat(64)}`,
    expiresAt: 200,
  });
  expect(await broker.acquire("acme/repo", "git")).toBe("offline_first");
  unavailable = true;
  await expect(broker.acquire("acme/repo", "git")).rejects.toThrow(/^github_credentials_unavailable$/);
  token = "offline_second";
  unavailable = false;
  expect(await broker.acquire("acme/repo", "git")).toBe("offline_second");
  expect(registered.has("offline_first")).toBe(true);
  expect(registered.has("offline_second")).toBe(true);
});

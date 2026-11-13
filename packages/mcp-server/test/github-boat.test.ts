import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Provider } from "@armada/core/server";

// Owning release boundary: the actual generated artifact must fit both private
// transport checks before any SSH. Full bootstrap semantics live in the OS test.
test("generated GitHub broker fits the private transport before SSH registration", async () => {
  // Match the portable builder's single-entry graph, without relying on another test or build step.
  const runtime = join(import.meta.dir, "../../agent-runtime");
  const result = await Bun.build({
    entrypoints: [join(runtime, "src/github-boat-main.ts")],
    target: "bun",
    outdir: join(runtime, "dist"),
  });
  if (!result.success) throw new AggregateError(result.logs, "GitHub broker fixture bundle failed");
  // The adapter's file import must resolve only after its fresh artifact exists.
  const { configureBoatGitHub } = await import("../src/github-boat.ts");
  let registrations = 0;
  const provider = {
    id: "boat",
    async sshKey() {
      registrations++;
      throw Error("offline transport boundary; never connect");
    },
  } as unknown as Provider;
  await expect(
    configureBoatGitHub(provider, "offline-fixture", {
      version: 1,
      revision: "1",
      generation: "offline-generation",
      url: "https://unreachable.invalid/api/internal/github/credentials",
      capability: `armada_gh_${"a".repeat(64)}`,
      expiresAt: Date.now() + 60000,
    }),
  ).rejects.toThrow("GitHub private bootstrap failed.");
  expect(registrations).toBe(1);
});

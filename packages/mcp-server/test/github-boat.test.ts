import { expect, test } from "bun:test";
import type { Provider } from "@armada/core/server";
import { configureBoatGitHub } from "../src/github-boat.ts";

// Owning release boundary: the actual generated artifact must fit both private
// transport checks before any SSH. Full bootstrap semantics live in the OS test.
test("generated GitHub broker fits the private transport before SSH registration", async () => {
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

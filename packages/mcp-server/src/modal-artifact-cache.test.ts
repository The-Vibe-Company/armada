import { expect, test } from "bun:test";
import { createModalArtifactCache } from "./modal-artifact-cache.ts";

test("Modal cache coalesces warming per binding and retries after a failed seed", async () => {
  const binding = { appId: "app", appName: "name", environment: "main", tokenId: "id", tokenSecret: "secret" };
  const runtime = { sha256: "a".repeat(64), bytes: 1 };
  const archive = { sha256: "b".repeat(64), bytes: 2 };
  const opencode = { sha256: "c".repeat(64), bytes: 3 };
  const environments: string[] = [];
  const warm = createModalArtifactCache(
    { runtime, harnesses: { codex: { archive } }, opencode },
    "/public",
    async (request) => {
      expect(request.pins).toEqual([runtime, archive, opencode]);
      expect(request.directory).toBe("/public");
      environments.push(request.environment);
      if (environments.length === 1) throw Error("seed failed");
    },
  );

  const failed = warm(binding);
  expect(warm(binding)).toBe(failed);
  await expect(failed).rejects.toThrow("seed failed");
  await warm(binding);
  await warm(binding);
  await warm({ ...binding, environment: "other" });
  expect(environments).toEqual(["main", "main", "other"]);
});

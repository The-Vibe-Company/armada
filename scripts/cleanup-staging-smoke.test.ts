import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStagingSmoke } from "./cleanup-staging-smoke.ts";
import { STAGING_ORIGIN } from "./smoke-sandbox-cleanup.ts";

test("coordinator cleanup is staging-only, org-scoped and dry-run unless explicitly authorized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "historical-smoke-"));
  const manifest = join(directory, "manifest.json");
  let mutations = 0;
  const counts: unknown[] = [];
  const id = "22222222-2222-2222-2222-222222222222";
  const io = {
    out: (line: string) => counts.push(JSON.parse(line)),
    fetch: (async () => {
      mutations++;
      return Response.json({ id, status: "deleted" });
    }) as unknown as typeof fetch,
  };
  try {
    await writeFile(
      manifest,
      JSON.stringify([{ id, org: "staging", requestKey: "post-deploy-smoke:11111111-1111-1111-1111-111111111111" }]),
    );
    const env = {
      ARMADA_URL: STAGING_ORIGIN,
      ARMADA_SMOKE_JOURNAL: manifest,
      ARMADA_SMOKE_ORG: "staging",
      ARMADA_TOKEN: "token",
    };
    await expect(
      cleanupStagingSmoke({ ...env, ARMADA_URL: "https://production.invalid" }, ["--delete"], io),
    ).rejects.toThrow("staging_only");
    await expect(cleanupStagingSmoke({ ...env, ARMADA_SMOKE_ORG: "different" }, ["--delete"], io)).rejects.toThrow(
      "manifest_org_mismatch",
    );
    expect(await cleanupStagingSmoke(env, [], io)).toBe(true);
    expect(mutations).toBe(0);
    expect(counts).toContainEqual({ step: "historical_smoke_plan", dryRun: true, candidates: 1, batchLimit: 32 });
    expect(await cleanupStagingSmoke(env, ["--delete"], io)).toBe(true);
    expect(mutations).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

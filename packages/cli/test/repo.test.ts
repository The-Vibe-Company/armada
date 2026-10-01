import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan } from "../src/repo.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("the plan is never written through a linked folder, so the link's target stays intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-repo-"));
  dirs.push(root);
  await mkdir(join(root, ".agents/skills/armada-worker"), { recursive: true });
  await symlink(".agents", join(root, ".claude"));
  const plan = {
    writes: [],
    removes: [],
    links: [{ path: ".claude/skills/armada-worker", target: "../../.agents/skills/armada-worker" }],
    installed: [],
    updated: [],
    stopHook: false,
  };
  await expect(applyPlan(root, plan)).rejects.toThrow(".claude is a link; Armada does not write through it");
  expect(await readdir(join(root, ".agents/skills/armada-worker"))).toEqual([]);
});

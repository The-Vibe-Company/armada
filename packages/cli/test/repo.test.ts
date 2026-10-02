import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("a skill file symlink refuses the whole update before any write", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-repo-"));
  dirs.push(home);
  const root = join(home, "checkout");
  await mkdir(root);
  const outside = join(home, "outside.txt");
  await writeFile(outside, "original");
  await mkdir(join(root, ".agents/skills/review-code-dev/scripts"), { recursive: true });
  const linked = ".agents/skills/review-code-dev/scripts/ocr.py";
  await symlink(outside, join(root, linked));
  await expect(
    applyPlan(root, {
      writes: [
        { path: "before.txt", content: "must not be written" },
        { path: linked, content: "replacement" },
      ],
      removes: [],
      links: [],
      installed: [],
      updated: [],
      stopHook: false,
    }),
  ).rejects.toThrow(`${linked} is a link; Armada does not write through it`);
  expect(await readFile(outside, "utf8")).toBe("original");
  expect(await readFile(join(root, "before.txt"), "utf8").catch(() => null)).toBeNull();
});

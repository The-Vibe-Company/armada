import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BUNDLED_SKILLS } from "../src/skills.ts";

const SKILLS_DIR = join(import.meta.dir, "../../../skills");

test("the bundle carries every file under skills/, byte for byte", async () => {
  const onDisk: Record<string, string> = {};
  for (const entry of await readdir(SKILLS_DIR, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const full = join(entry.parentPath, entry.name);
      if (full.split("/").includes("__pycache__")) continue;
      onDisk[full.slice(SKILLS_DIR.length + 1)] = await readFile(full, "utf8");
    }
  const bundled = Object.fromEntries(
    BUNDLED_SKILLS.flatMap((s) => s.files.map((f) => [`${s.name}/${f.path}`, f.content])),
  );
  expect(bundled).toEqual(onDisk);
});

test("every runtime guide has the sections the coordinator and armada merge point at", () => {
  const guides = BUNDLED_SKILLS.filter((s) => s.name.startsWith("armada-runtime-"));
  expect(guides.map((s) => s.name)).toEqual(["armada-runtime-claude-code", "armada-runtime-conductor"]);
  for (const guide of guides) {
    const headings = (guide.files.find((f) => f.path === "SKILL.md")?.content ?? "").match(/^## .+$/gm);
    expect(headings?.slice(0, 4)).toEqual(["## Launch", "## Message", "## Status", "## Stop and archive"]);
  }
});

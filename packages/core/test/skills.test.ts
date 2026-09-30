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
      onDisk[full.slice(SKILLS_DIR.length + 1)] = await readFile(full, "utf8");
    }
  const bundled = Object.fromEntries(
    BUNDLED_SKILLS.flatMap((s) => s.files.map((f) => [`${s.name}/${f.path}`, f.content])),
  );
  expect(bundled).toEqual(onDisk);
});

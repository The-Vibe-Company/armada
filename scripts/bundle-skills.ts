// Generate text literals for every nested skill file. The CLI can then carry
// the complete packages under Node without runtime filesystem or Bun APIs.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "../skills");
const skills = [];
for (const name of (await readdir(root)).sort()) {
  const files = [];
  const folder = join(root, name);
  for (const path of (await readdir(folder, { recursive: true })).sort()) {
    if (path.split("/").includes("__pycache__")) continue;
    try {
      files.push({ path, content: await readFile(join(folder, path), "utf8") });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EISDIR") throw err;
    }
  }
  skills.push({ name, delivery: name.startsWith("armada-") ? "pointer" : "vendored", files });
}
await writeFile(
  join(import.meta.dir, "../packages/core/src/skills.generated.json"),
  `${JSON.stringify(skills, null, 2)}\n`,
);

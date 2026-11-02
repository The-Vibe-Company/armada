import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Public guidance contract: coordinator refusals must name tools that this daemon admits.
// The worker launch brief alone bootstraps the separately installed worker CLI.
test("native, merge and worker refusal guidance never directs a coordinator to V1", () => {
  const root = new URL("../", import.meta.url);
  const paths = [
    "coordinator/native.ts",
    "coordinator/tickets.ts",
    "coordinator/system.md",
    "coordinator/follow-ups.ts",
  ];
  const visit = (directory: string) => {
    for (const entry of readdirSync(new URL(directory, root), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (path.endsWith(".ts") && path !== "src/workers/brief.ts") paths.push(path);
    }
  };
  visit("src/merge");
  visit("src/workers");
  for (const path of paths) {
    const source = readFileSync(new URL(path, root), "utf8");
    assert.doesNotMatch(source, /armada |armada\.toml/, path);
    assert.doesNotMatch(
      source,
      /capacity unavailable|No live worker in this daemon|confirme[rz]?-moi la capacit[eé]|confirm (?:the |available )?(?:capacity|slots)|v[eé]rifie.*workers actifs/i,
      path,
    );
  }
});

import { expect, test } from "bun:test";
import { BUNDLED_SKILLS } from "../src/skills.ts";

test("every runtime guide has the sections the coordinator and armada merge point at", () => {
  const guides = BUNDLED_SKILLS.filter((s) => s.name.startsWith("armada-runtime-"));
  expect(guides.map((s) => s.name)).toEqual([
    "armada-runtime-claude-code",
    "armada-runtime-conductor",
    "armada-runtime-herdr",
  ]);
  for (const guide of guides) {
    const headings = (guide.files.find((f) => f.path === "SKILL.md")?.content ?? "").match(/^## .+$/gm);
    expect(headings?.slice(0, 4)).toEqual(["## Launch", "## Message", "## Status", "## Stop and archive"]);
  }
});

import { expect, test } from "bun:test";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";

test("skills update applies init's bundle locally without credentials or remote calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-skills-"));
  try {
    await writeFile(
      join(root, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: { custom: { source: "acme/tools", sourceType: "github", computedHash: "custom" } },
      }),
    );
    const output: string[] = [];
    const io: Io = {
      cwd: root,
      env: { XDG_CONFIG_HOME: join(root, "machine") },
      readFile: async () => {
        throw new Error("no credential or config reads expected");
      },
      fetch: async () => {
        throw new Error("no network expected");
      },
      stdout: (s) => output.push(s),
      stderr: (s) => {
        throw new Error(s);
      },
      ghToken: () => null,
      exec: async (command, args) => {
        expect([command, ...args]).toEqual(["git", "rev-parse", "--show-toplevel"]);
        return { code: 0, stdout: root, stderr: "" };
      },
    };
    expect(await run(["skills", "update", "--json"], io)).toBe(0);
    expect(JSON.parse(output.join("")).installed).toContain("ship-pr-dev");
    expect(await readFile(join(root, ".agents/skills/review-code-dev/scripts/ocr.py"), "utf8")).toContain("CHECKSUMS");
    expect(await readlink(join(root, ".claude/skills/ship-pr-dev"))).toBe("../../.agents/skills/ship-pr-dev");
    expect(JSON.parse(await readFile(join(root, "skills-lock.json"), "utf8")).skills.custom.computedHash).toBe(
      "custom",
    );
    output.length = 0;
    expect(await run(["skills", "update"], io)).toBe(0);
    expect(output.join("")).toContain("already match");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

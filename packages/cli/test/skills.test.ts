import { expect, test } from "bun:test";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_SKILLS } from "@armada/core";
import { commandHelp, run } from "../src/cli.ts";
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

// Every `armada …` command the bundled instructions name must exist in `armada --help`,
// with its literal subcommand and each flag, so the skills cannot drift from the CLI.
test("every armada command, subcommand and flag the armada-* skills name is in armada --help", () => {
  const problems: string[] = [];
  for (const skill of BUNDLED_SKILLS.filter((s) => s.name.startsWith("armada-")))
    for (const file of skill.files.filter((f) => f.path.endsWith(".md")))
      for (const span of codeSpans(file.content))
        for (const command of span.split(/ \| |&&|;|\$\(/))
          for (const [, rest] of command.matchAll(/(?:^|[\s(])armada ([a-z].*?)(?=\s+armada |$)/g)) {
            const where = `${skill.name}/${file.path}: \`${command.trim()}\``;
            const words = (rest ?? "").split(" -- ")[0]?.split(/\s+/) ?? [];
            const name = words[0] ?? "";
            const help = commandHelp(name);
            if (!help) {
              problems.push(`${where}: no command "${name}"`);
              continue;
            }
            const subcommands = [...help.matchAll(new RegExp(`^ {2}${name} ([a-z][a-z-]*)`, "gm"))].map((m) => m[1]);
            const second = words[1] ?? "";
            if (subcommands.length > 0 && /^[a-z][a-z-]*$/.test(second) && !subcommands.includes(second))
              problems.push(`${where}: no subcommand "${name} ${second}"`);
            for (const [flag] of (rest ?? "").split(" -- ")[0]?.matchAll(/(?<![\w-])--[a-z][a-z-]*/g) ?? [])
              if (!new RegExp(`${flag}(?![a-z-])`).test(help)) problems.push(`${where}: no flag ${flag} on "${name}"`);
          }
  expect(problems).toEqual([]);
});

test("the coordinator's main instructions stay within their size budget", () => {
  const coordinator = BUNDLED_SKILLS.find((s) => s.name === "armada-coordinator");
  const main = coordinator?.files.find((f) => f.path === "SKILL.md")?.content ?? "";
  expect(new TextEncoder().encode(main).length).toBeLessThanOrEqual(COORDINATOR_BUDGET);
});

/** Bytes of the coordinator's SKILL.md: detail goes to MERGE.md or REFERENCE.md instead. */
const COORDINATOR_BUDGET = 24_000;

/** Inline code spans and the lines of fenced blocks. */
function codeSpans(markdown: string): string[] {
  const spans: string[] = [];
  const parts = markdown.split(/^```.*$/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) spans.push(...part.split("\n"));
    else for (const [, span] of part.matchAll(/`([^`\n]+)`/g)) spans.push(span ?? "");
  });
  return spans;
}

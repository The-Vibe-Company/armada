import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const skill = join(root, ".agents/skills/armada");

type Command = { path: string[]; flags: Set<string> };

// Use the running CLI's public usage contract, scoped to each usage row rather
// than accepting a flag merely because some unrelated command advertises it.
function commands(help: string): Command[] {
  const result: Command[] = [];
  for (const row of help.split(/^ {2}armada /m).slice(1)) {
    const first = row.split("\n")[0] ?? "";
    const path = first.split(/\s+/).filter((_part, index, all) => {
      return all.slice(0, index + 1).every((word) => /^[a-z][a-z|-]*$/.test(word));
    });
    if (path.length === 0 || first.slice(path.join(" ").length).trimStart().startsWith("--help")) continue;
    let variants: string[][] = [[]];
    for (const part of path) variants = variants.flatMap((prefix) => part.split("|").map((word) => [...prefix, word]));
    const flags = new Set(row.match(/--[a-z][a-z-]*/g) ?? []);
    for (const variant of variants) {
      const existing = result.find((entry) => entry.path.join(" ") === variant.join(" "));
      if (existing) for (const flag of flags) existing.flags.add(flag);
      else result.push({ path: variant, flags: new Set(flags) });
    }
  }
  return result;
}

function invocations(markdown: string): string[] {
  const result: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      if (/^\s*armada\s/.test(line)) result.push(line.trim());
    } else {
      for (const match of line.matchAll(/`(armada\s[^`]+)`/g)) result.push(match[1] ?? "");
    }
  }
  return result;
}

function validate(invocation: string, contract: Command[]): string | undefined {
  // Quoted prompt/exec text is data, not a set of Armada options.
  const tokens = (invocation.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? []).slice(1);
  if (tokens.length === 1 && ["--help", "--version"].includes(tokens[0] ?? "")) return;
  if (
    tokens.at(-1) === "--help" &&
    contract.some((candidate) => tokens.slice(0, -1).every((word, index) => candidate.path[index] === word))
  )
    return;
  const command = contract
    .filter((candidate) => candidate.path.every((word, index) => tokens[index] === word))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!command) return `Unknown command: ${invocation}`;
  for (const token of tokens.slice(command.path.length)) {
    if (token === "--") break;
    if (token.startsWith("--") && !command.flags.has(token.split("=")[0] ?? token)) {
      return `Unknown flag for ${command.path.join(" ")}: ${token}`;
    }
  }
}

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

test("published Armada skill commands and flags match the live CLI usage contract", async () => {
  const contract: Command[] = [];
  for (const prefix of [[], ["template"], ["routine"], ["vars"], ["secrets"], ["skill"]]) {
    const child = Bun.spawn([process.execPath, "packages/cli/src/main.ts", ...prefix, "--help"], {
      cwd: root,
      env: { ...process.env, ARMADA_TOKEN: "", ARMADA_URL: "http://127.0.0.1:1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(status, err).toBe(0);
    contract.push(...commands(out));
  }
  const errors: string[] = [];
  let count = 0;
  for (const file of await markdownFiles(skill)) {
    for (const invocation of invocations(await Bun.file(file).text())) {
      count++;
      const error = validate(invocation, contract);
      if (error) errors.push(`${relative(root, file)}: ${error}`);
    }
  }
  expect(count).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  // Negative controls prove the gate rejects command removal and a flag moved
  // to an unrelated command, not just a broken fixture or missing skill file.
  expect(validate("armada nonexistent-command", contract)).toContain("Unknown command");
  expect(validate("armada golden nonexistent-subcommand", contract)).toContain("Unknown command");
  expect(validate("armada launch example --nonexistent-flag", contract)).toContain("Unknown flag");
  expect(validate("armada stop sandbox --skill team/example@1.0.0", contract)).toContain("Unknown flag");
  expect(validate("armada routine enable routine --revision 1", contract)).toContain("Unknown flag");
});

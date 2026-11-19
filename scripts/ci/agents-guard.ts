import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

const budgets = new Map([
  ["AGENTS.md", 9_216],
  ["packages/mcp-server/AGENTS.md", 7_168],
]);
const generatedNextRules =
  /^<!-- BEGIN:nextjs-agent-rules -->\r?\n[\s\S]*?^<!-- END:nextjs-agent-rules -->(?:\r?\n|$)/m;
const extensions =
  "c cjs css html ico jpeg jpg js json jsonc jsx lock md mjs plist png py sh snap sql svg swift toml ts tsx txt woff2 xcconfig yaml yml".split(
    " ",
  );
const fileExtension = new RegExp(`\\.(?:${extensions.join("|")})(?=$|[,}])`, "i");
const pathToken = /^[\p{L}\p{N}_.*{(-][\p{L}\p{M}\p{N}_./*{},@()+-]*$/u;

function hasKnownExtension(token: string) {
  if (fileExtension.test(token)) return true;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return false;
  const suffix = token.slice(dot);
  if (!/[*{]/.test(suffix)) return false;
  const glob = new Bun.Glob(suffix.toLowerCase());
  return extensions.some((extension) => glob.match(`.${extension}`));
}

export function checkAgentsFiles(files: ReadonlyMap<string, string>, exists: (path: string) => boolean) {
  const errors: string[] = [];
  for (const [path, content] of files) {
    if (posix.basename(path) !== "AGENTS.md") continue;

    const rules = path === "apps/dashboard/AGENTS.md" ? content.replace(generatedNextRules, "") : content;
    const bytes = Buffer.byteLength(rules);
    const budget = budgets.get(path) ?? 4_096;
    if (bytes > budget) errors.push(`${path}: byte budget: ${bytes} bytes exceeds ${budget} bytes`);

    for (const match of rules.matchAll(/#\d+|\b20\d\d-\d\d-\d\d\b/g)) {
      errors.push(`${path}: history: ${match[0]}`);
    }

    for (const [, , token] of rules.matchAll(/(?<!`)(`+)([^`\n]+)\1(?!`)/g)) {
      if (!token || !pathToken.test(token) || (!token.includes("/") && !hasKnownExtension(token))) continue;
      if (!exists(token.replace(/^\.\//, "").replace(/\/$/, ""))) {
        errors.push(`${path}: missing repository path: ${token}`);
      }
    }

    if (path !== "AGENTS.md") {
      const sibling = posix.join(posix.dirname(path), "CLAUDE.md");
      const redirect = files.get(sibling);
      if (redirect === undefined || !/^@AGENTS\.md(?:\r?\n)?$/.test(redirect)) {
        errors.push(
          `${path}: sibling redirect: ${sibling} must contain @AGENTS.md (found ${JSON.stringify(redirect) ?? "missing"})`,
        );
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "../..");
  const tracked = new Set(
    execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean),
  );
  const files = new Map<string, string>();
  const directories = new Set<string>();
  for (const path of tracked) {
    if (["AGENTS.md", "CLAUDE.md"].includes(posix.basename(path)) && existsSync(join(root, path))) {
      files.set(path, readFileSync(join(root, path), "utf8"));
    }
    for (let directory = dirname(path); directory !== "."; directory = dirname(directory)) {
      if (directories.has(directory)) break;
      directories.add(directory);
    }
  }

  const errors = checkAgentsFiles(files, (path) => {
    if (!/[*{]/.test(path)) {
      return (tracked.has(path) || directories.has(path)) && existsSync(join(root, path));
    }
    const glob = new Bun.Glob(path);
    for (const file of tracked) {
      if (glob.match(file) && existsSync(join(root, file))) return true;
    }
    return false;
  });
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}

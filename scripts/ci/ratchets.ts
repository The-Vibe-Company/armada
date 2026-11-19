import { lstatSync, readFileSync } from "node:fs";
import { providerAdapterExclusions, providerBranchPattern, testPaths } from "../metrics/architecture-rules";

const serverAdapters = new Set(
  [
    "boat-delegated-access-provider.ts",
    "boat-inventory-report.ts",
    "boat-runtime-launch.ts",
    "boat-runtime-resume.ts",
    "docker-runtime-lifecycle.ts",
    "modal-integration.ts",
    "modal-reaper.ts",
    "modal-runtime-launch.ts",
    "modal-runtime-resume.ts",
    "observed-boat.ts",
  ].map((name) => `packages/mcp-server/src/${name}`),
);

const serverSource = /^packages\/mcp-server\/src\//;
const routeTables = /^packages\/mcp-server\/src\/(?:public-rest-routes|control[^/]*)\.ts$/;

type Counter = {
  name: string;
  includes: (path: string) => boolean;
  pattern: RegExp;
};

const counters: Record<string, Counter | null> = {
  "provider-branch": {
    name: "provider-branch",
    includes: (path) => !providerAdapterExclusions.test(path) && !serverAdapters.has(path),
    pattern: providerBranchPattern,
  },
  "versioned-route": {
    name: "versioned-route",
    includes: (path) => routeTables.test(path),
    pattern: /(["'])\/?[\w/{}-]*-v\d+(?:\/[\w/{}-]*)?\1/g,
  },
  "deprecation-header": {
    name: "deprecation-header",
    includes: (path) => serverSource.test(path),
    pattern: /(["'`])(?:deprecation|sunset)\1|\b(?:deprecation|sunset)\b(?=\s*:)/gi,
  },
  "native-path": null,
  "append-point": null,
};

const activeCounters = Object.values(counters).filter((counter) => counter !== null);
type Files = ReadonlyMap<string, string>;

function inScope(path: string) {
  return path.endsWith(".ts") && !testPaths.test(path);
}

function* matches(counter: Counter, files: Files) {
  for (const [path, content] of files) {
    if (!inScope(path) || !counter.includes(path)) continue;
    for (const match of content.matchAll(counter.pattern)) {
      yield { path, content, index: match.index, text: match[0] };
    }
  }
}

function count(counter: Counter, files: Files) {
  let total = 0;
  for (const _match of matches(counter, files)) total++;
  return total;
}

function matchContext({ path, content, index, text }: { path: string; content: string; index: number; text: string }) {
  const from = index === 0 ? 0 : content.lastIndexOf("\n", index - 1) + 1;
  const to = content.indexOf("\n", index + text.length);
  return JSON.stringify([path, text, content.slice(from, to === -1 ? undefined : to).trim()]);
}

function take(counts: Map<string, number>, key: string) {
  const available = counts.get(key) ?? 0;
  if (available === 0) return false;
  counts.set(key, available - 1);
  return true;
}

export function compare(base: Files | undefined, head: Files) {
  return activeCounters.map((counter) => {
    const before = base === undefined ? undefined : count(counter, base);
    const after = count(counter, head);
    const added: { path: string; line: number; text: string }[] = [];
    if (base !== undefined && before !== undefined && after > before) {
      const exact = new Map<string, number>();
      const remaining = new Map<string, number>();
      for (const match of matches(counter, base)) {
        const key = matchContext(match);
        exact.set(key, (exact.get(key) ?? 0) + 1);
        remaining.set(match.text, (remaining.get(match.text) ?? 0) + 1);
      }
      const unmatched = [];
      for (const match of matches(counter, head)) {
        if (take(exact, matchContext(match))) take(remaining, match.text);
        else unmatched.push(match);
      }
      for (const { path, content, index, text } of unmatched) {
        if (!take(remaining, text)) {
          added.push({ path, line: content.slice(0, index).split("\n").length, text });
        }
      }
    }
    return { name: counter.name, before, after, added };
  });
}

function git(args: string[], options: { stdin?: string; exitOne?: boolean } = {}) {
  const result = Bun.spawnSync(["git", ...args], {
    stdin: options.stdin === undefined ? undefined : Buffer.from(options.stdin),
    stderr: "pipe",
  });
  if (result.exitCode === 0 || (options.exitOne && result.exitCode === 1)) return result.stdout;
  throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
}

function readHead() {
  const paths = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).toString().split("\0");
  const files = new Map<string, string>();
  for (const path of paths) {
    if (!inScope(path) || files.has(path) || !lstatSync(path, { throwIfNoEntry: false })?.isFile()) continue;
    files.set(path, readFileSync(path, "utf8"));
  }
  return files;
}

function readBase(base: string) {
  const objects = git(
    ["grep", "--text", "-ilz", "-E", "-e", "boat|modal|docker|switch|-v[0-9]|deprecation|sunset", base, "--", "*.ts"],
    { exitOne: true },
  )
    .toString()
    .split("\0")
    .filter((object) => object && inScope(object.slice(base.length + 1)));
  const files = new Map<string, string>();
  if (objects.length === 0) return files;

  const output = git(["cat-file", "-z", "--batch"], { stdin: objects.join("\0") + "\0" });
  let offset = 0;
  for (const object of objects) {
    const headerEnd = output.indexOf(10, offset);
    const header = /^\S+ blob (\d+)$/.exec(output.toString("utf8", offset, headerEnd));
    if (!header) throw new Error("Expected a blob from git cat-file for " + object);
    const end = headerEnd + 1 + Number(header[1]);
    if (output[end] !== 10) throw new Error("Incomplete blob from git cat-file for " + object);
    files.set(object.slice(base.length + 1), output.toString("utf8", headerEnd + 1, end));
    offset = end + 1;
  }
  return files;
}

if (import.meta.main) {
  const requestedBase = Bun.argv[2];
  const base = git(
    [
      "rev-parse",
      "--verify",
      ...(requestedBase === undefined ? ["--quiet"] : []),
      "--end-of-options",
      `${requestedBase ?? "origin/main"}^{commit}`,
    ],
    {
      exitOne: requestedBase === undefined,
    },
  )
    .toString()
    .trim();
  if (!base) console.log("No origin/main available. Showing working-tree counts.");
  for (const { name, before, after, added } of compare(base ? readBase(base) : undefined, readHead())) {
    console.log(before === undefined ? `${name}: ${after}` : `${name}: base ${before}, head ${after}`);
    for (const { path, line, text } of added) console.error(`  ${path}:${line}: ${text.replace(/\s+/g, " ")}`);
    if (added.length > 0) process.exitCode = 1;
  }
}

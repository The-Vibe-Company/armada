import { writeFileSync } from "node:fs";
import { parseMigrationHistory } from "./staging-migration-history";

const openApiPath = "packages/mcp-server/openapi.json";
const runtimePath = "packages/agent-runtime/src/protocol.ts";
const dockerHostPath = "packages/core/src/docker-host-protocol.ts";
const stableTag = /^v\d+\.\d+\.\d+$/;

export function protocolChange(previous: string, current: string, name: string) {
  return { from: protocol(previous, name), to: protocol(current, name) };
}

function protocol(source: string, name: string): number | null {
  const value = source.match(new RegExp(`^export const ${name} = ([1-9][0-9]*);$`, "m"))?.[1];
  return value && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const annotations = new Set(["description", "summary", "title", "example", "examples", "externalDocs", "$comment"]);

function removedContract(previous: unknown, current: unknown, path: string): string[] {
  if (Array.isArray(previous)) {
    // Ignore reordering. An altered alternative is ambiguous, so require a forward release.
    const next = Array.isArray(current) ? current : [];
    return previous.every((value) => next.some((candidate) => Bun.deepEquals(value, candidate))) ? [] : [path];
  }

  const before = object(previous);
  const after = object(current);
  return Object.entries(before).flatMap(([key, value]) => {
    if (annotations.has(key) || key.startsWith("x-")) return [];
    const field = `${path}/${key}`;
    if (!(key in after)) return [field];
    if (key === "properties") {
      return Object.entries(object(value)).flatMap(([name, schema]) => {
        const next = object(after[key]);
        const property = `${field}/${name}`;
        return Object.hasOwn(next, name) ? removedContract(schema, next[name], property) : [property];
      });
    }
    if (key === "$ref" && value !== after[key]) return [field];
    return removedContract(value, after[key], field);
  });
}

export function surfaceBreaks(previous: unknown, current: unknown, commits: string[]): string[] {
  const breaks = commits
    .filter((message) => /^[\w-]+(?:\([^\r\n]+\))?!:/.test(message) || /^BREAKING[ -]CHANGE:/m.test(message))
    .map((message) => `commit: ${message.split("\n", 1)[0]}`);
  const before = object(previous).paths;
  const after = object(current).paths;
  if (!before || !after || typeof before !== "object" || typeof after !== "object")
    return [...breaks, "OpenAPI comparison unavailable"];
  for (const [path, value] of Object.entries(object(before))) {
    const next = object(object(after)[path]);
    for (const [method, operation] of Object.entries(object(value))) {
      if (!methods.has(method)) continue;
      const label = `${method.toUpperCase()} ${path}`;
      if (!(method in next)) breaks.push(label);
      else breaks.push(...removedContract(operation, next[method], label));
    }
    breaks.push(...removedContract(object(value).parameters, next.parameters, `path parameters: ${path}`));
  }
  breaks.push(...removedContract(object(previous).components, object(current).components, "components"));
  return [...new Set(breaks)];
}

export function migrationChanges(previous: string[], before: string[], after: string[], changedPaths: string[]) {
  const versions = changedPaths.map((path) => {
    const version = path.match(/^supabase\/migrations\/(\d{14})_[^/]+\.sql$/)?.[1];
    if (!version) throw new Error(`Invalid migration path: ${path}`);
    return version;
  });
  // The tag comparison retains evidence when a previous attempt applied SQL and then failed.
  return [
    ...new Set([...versions, ...after.filter((version) => !before.includes(version) || !previous.includes(version))]),
  ].sort();
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args]);
  if (result.exitCode !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

function snapshot(ref: string, path: string): string {
  return git("ls-tree", "--name-only", ref, "--", path) ? git("show", `${ref}:${path}`) : "";
}

function lines(value: string): string[] {
  return value.split("\n").filter(Boolean);
}

if (import.meta.main) {
  const { RELEASE_SHA: sha, RELEASE_VERSION: version, RELEASE_RECEIPT_DIR: directory } = process.env;
  if (!sha || !version || !directory || !stableTag.test(`v${version}`) || git("rev-parse", "HEAD") !== sha)
    throw new Error("Invalid release receipt context");
  const tag = `v${version}`;
  const [latest, previous] = lines(git("tag", "--list", "v*", "--sort=-version:refname")).filter((tag) =>
    stableTag.test(tag),
  );
  if (latest !== tag || git("rev-parse", `refs/tags/${tag}^{commit}`) !== sha)
    throw new Error("Release receipt requires the latest stable tag on the deployment SHA");
  const ref = previous ? `refs/tags/${previous}` : null;
  if (ref) git("merge-base", "--is-ancestor", ref, sha);

  const [before, after, serverDeployment, dashboardDeployment, pin] = await Promise.all(
    (["history-before", "history-after", "server", "dashboard", "image"] as const).map(async (file) =>
      (await Bun.file(`${directory}/${file}`).text()).trim(),
    ),
  );
  if (!serverDeployment || !dashboardDeployment || !pin) throw new Error("Missing deployment evidence");
  const migrations = migrationChanges(
    ref
      ? lines(git("ls-tree", "-r", "--name-only", ref, "--", "supabase/migrations")).flatMap(
          (path) => path.match(/^supabase\/migrations\/(\d{14})_[^/]+\.sql$/)?.[1] ?? [],
        )
      : [],
    parseMigrationHistory(before ?? "").remote,
    parseMigrationHistory(after ?? "").remote,
    ref ? lines(git("diff", "--name-only", "--no-renames", ref, sha, "--", "supabase/migrations")) : [],
  );
  const values = (path: string, name: string) =>
    protocolChange(ref ? snapshot(ref, path) : "", snapshot(sha, path), name);
  const protocolBump = {
    runtime: values(runtimePath, "PROTOCOL_VERSION"),
    dockerHost: values(dockerHostPath, "DOCKER_HOST_PROTOCOL"),
  };
  if (protocolBump.runtime.to === null || protocolBump.dockerHost.to === null)
    throw new Error("Missing current protocol version");
  const api = (commit: string) => JSON.parse(snapshot(commit, openApiPath) || "null") as unknown;
  const receipt = {
    version,
    sha,
    previousVersion: previous?.slice(1) ?? null,
    serverDeployment,
    dashboardDeployment,
    imageDigest: pin === "none" ? null : pin.split("@")[1],
    migrations,
    protocolBump,
    surfaceBreak: surfaceBreaks(
      ref ? api(ref) : null,
      api(sha),
      ref
        ? git("log", "--format=%B%x00", `${ref}..${sha}`)
            .split("\0")
            .map((message) => message.trim())
        : [],
    ),
  };
  writeFileSync(`${directory}/release-receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
}

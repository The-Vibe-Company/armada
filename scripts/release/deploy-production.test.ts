import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "deploy-production.sh");

// Exercise the real shell entrypoint; fake only external provider executables.
function deploy(failure = "", missing = "", pinVersion?: string, source = "") {
  const dir = mkdtempSync(join(tmpdir(), "release-deploy-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const run = (args: string[]) => {
      const result = Bun.spawnSync(args, { cwd: dir });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    run(["git", "init", "--quiet"]);
    writeFileSync(join(dir, "package.json"), '{"version":"1.2.3"}');
    mkdirSync(join(dir, "packages/core/src"), { recursive: true });
    writeFileSync(join(dir, "packages/core/src/official-sandbox-image.json"), "null");
    run(["git", "add", "package.json", "packages/core/src/official-sandbox-image.json"]);
    run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"]);
    const sha = run(["git", "rev-parse", "HEAD"]);
    if (pinVersion)
      writeFileSync(
        join(dir, "packages/core/src/official-sandbox-image.json"),
        JSON.stringify({
          version: pinVersion,
          image: `ghcr.io/the-vibe-company/armada-sandbox@sha256:${"a".repeat(64)}`,
        }),
      );
    const log = join(dir, "calls");
    writeFileSync(join(dir, "outputs"), "");
    const executable = (name: string, body: string) =>
      writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
    const actualGit = Bun.which("git");
    if (!actualGit) throw new Error("git is required for the fixture");
    executable(
      "git",
      `if [[ "$1" == ls-remote ]]; then printf '%s\\trefs/heads/main\\n' "$REMOTE_HEAD"; else exec ${JSON.stringify(actualGit)} "$@"; fi`,
    );
    executable("supabase", 'echo "supabase $*" >> "$CALLS"; [[ "$FAILURE" != migrations ]]');
    executable(
      "railway",
      `echo "railway $*" >> "$CALLS"
if [[ "$1" == up ]]; then
  if [[ -n "$PIN_VERSION" ]]; then
    jq -e '.version == "1.2.3" and (.image | endswith("${"a".repeat(64)}"))' packages/core/src/official-sandbox-image.json >/dev/null
  fi
  echo '{"deploymentId":"selected"}'
else
  # Another deployment being healthy must not let this release continue.
  if [[ "$FAILURE" == server ]]; then status=FAILED; else status=SUCCESS; fi
  printf '[{"id":"other","status":"SUCCESS"},{"id":"selected","status":"%s"}]' "$status"
fi`,
    );
    executable(
      "curl",
      `echo curl >> "$CALLS"
if [[ "$FAILURE" == health ]]; then echo '{"ok":true,"version":"0.0.0"}'; else printf '{"ok":true,"version":"1.2.3","commit":"%s"}' "$RELEASE_SHA"; fi`,
    );
    executable("vercel", 'echo "vercel $*" >> "$CALLS"; [[ "$FAILURE" != "dashboard-$1" ]]');
    executable("sleep", ":");
    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH}`,
      CALLS: log,
      FAILURE: failure,
      PIN_VERSION: pinVersion ?? "",
      // A legacy environment flag must not restore the retired missing-token path.
      DEPLOYMENT_ENVIRONMENT: "staging",
      HOME: dir,
      RELEASE_SHA: sha,
      REMOTE_HEAD: source === "current" ? sha : source === "unresolved" ? "invalid" : "b".repeat(40),
      STAGING_LATEST_ONLY: source && source !== "pinned" ? "true" : "false",
      GITHUB_OUTPUT: join(dir, "outputs"),
      RELEASE_VERSION: "1.2.3",
      ARMADA_SERVER_URL: "https://server.example.invalid",
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
    };
    for (const key of [
      "SUPABASE_ACCESS_TOKEN",
      "SUPABASE_DB_PASSWORD",
      "SUPABASE_PROJECT_ID",
      "RAILWAY_TOKEN",
      "RAILWAY_PROJECT_ID",
      "RAILWAY_ENVIRONMENT_ID",
      "RAILWAY_SERVICE_ID",
      "VERCEL_TOKEN",
      "VERCEL_ORG_ID",
      "VERCEL_PROJECT_ID",
    ])
      env[key] = "fixture";
    delete env[missing];
    const result = Bun.spawnSync(["bash", script], { cwd: dir, env });
    let calls = "";
    try {
      calls = readFileSync(log, "utf8");
    } catch {
      /* No provider invoked. */
    }
    return {
      code: result.exitCode,
      calls,
      output: readFileSync(join(dir, "outputs"), "utf8"),
      error: result.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("release uploads and gates providers in migration/server/health/dashboard order", () => {
  const result = deploy();
  expect(result.code).toBe(0);
  expect(
    result.calls
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ")[0]),
  ).toEqual([
    "supabase",
    "supabase",
    "supabase",
    "supabase",
    "supabase",
    "railway",
    "railway",
    "curl",
    "vercel",
    "vercel",
    "vercel",
  ]);
  expect(result.calls).toContain("vercel pull --yes --environment=production");
  expect(result.calls).toContain("vercel build --prod");
  expect(result.calls).toContain("vercel deploy --prebuilt --prod --yes");
  expect(result.calls).not.toContain("--token");
});

test.each(["migrations", "server", "health", "dashboard-pull", "dashboard-build", "dashboard-deploy"])(
  "%s failure stops later release stages",
  (failure) => {
    const result = deploy(failure);
    expect(result.code).not.toBe(0);
    if (failure === "migrations") expect(result.calls).not.toContain("railway");
    if (!failure.startsWith("dashboard-")) expect(result.calls).not.toContain("vercel");
    if (failure === "dashboard-pull") expect(result.calls).not.toContain("vercel build");
    if (failure === "dashboard-pull" || failure === "dashboard-build")
      expect(result.calls).not.toContain("vercel deploy");
  },
);

test.each(["VERCEL_TOKEN", "RAILWAY_TOKEN", "RAILWAY_SERVICE_ID"])(
  "missing %s fails before any deployment mutation",
  (key) => {
    const result = deploy("", key);
    expect(result.code).not.toBe(0);
    expect(result.calls).toBe("");
    expect(result.error).toContain(`Missing deployment environment secret/configuration: ${key}`);
  },
);

test.each(["current", "stale", "pinned", "unresolved"])(
  "%s source only supersedes ordinary queued main deployments",
  (source) => {
    const result = deploy("", "", undefined, source);
    expect(result.code).toBe(source === "unresolved" ? 1 : 0);
    if (source === "stale" || source === "unresolved") expect(result.calls).toBe("");
    else expect(result.calls).toContain("vercel deploy --prebuilt");
    if (source === "stale") expect(result.output).toContain("superseded=true");
  },
);

// The generated pin must survive git archive, and a foreign release must never reach a provider.
test("deployment carries only a matching generated official-image pin into the source archive", () => {
  expect(deploy("", "", "1.2.3").code).toBe(0);
  const wrong = deploy("", "", "0.0.1");
  expect(wrong.code).not.toBe(0);
  expect(wrong.calls).toBe("");
  expect(wrong.error).toContain("Official sandbox image pin does not match");
});

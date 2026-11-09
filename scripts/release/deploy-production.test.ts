import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "deploy-production.sh");

// Exercise the real shell entrypoint; fake only external provider executables.
function deploy(failure = "", missing = "") {
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
    run(["git", "add", "package.json"]);
    run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"]);
    const sha = run(["git", "rev-parse", "HEAD"]);
    const log = join(dir, "calls");
    const executable = (name: string, body: string) =>
      writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
    executable("supabase", 'echo "supabase $*" >> "$CALLS"; [[ "$FAILURE" != migrations ]]');
    executable(
      "railway",
      `echo "railway $*" >> "$CALLS"
if [[ "$1" == up ]]; then
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
if [[ "$FAILURE" == health ]]; then echo '{"ok":true,"version":"0.0.0"}'; else echo '{"ok":true,"version":"1.2.3"}'; fi`,
    );
    executable("vercel", 'echo "vercel $*" >> "$CALLS"; [[ "$FAILURE" != dashboard ]]');
    executable("sleep", ":");
    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH}`,
      CALLS: log,
      FAILURE: failure,
      HOME: dir,
      RELEASE_SHA: sha,
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
    return { code: result.exitCode, calls, error: result.stderr.toString() };
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
  ).toEqual(["supabase", "supabase", "supabase", "supabase", "supabase", "railway", "railway", "curl", "vercel"]);
});

test.each(["migrations", "server", "health", "dashboard"])("%s failure stops later release stages", (failure) => {
  const result = deploy(failure);
  expect(result.code).not.toBe(0);
  if (failure === "migrations") expect(result.calls).not.toContain("railway");
  if (failure !== "dashboard") expect(result.calls).not.toContain("vercel");
});

test("missing deployment configuration fails before any production mutation", () => {
  const result = deploy("", "VERCEL_TOKEN");
  expect(result.code).not.toBe(0);
  expect(result.calls).toBe("");
  expect(result.error).toContain("Missing production environment secret/configuration: VERCEL_TOKEN");
});

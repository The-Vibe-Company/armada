import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Step = { id?: string; run?: string };
const workflow = Bun.YAML.parse(
  readFileSync(resolve(import.meta.dir, "../../.github/workflows/release.yml"), "utf8"),
) as { jobs: Record<string, { steps: Step[] }> };

function script(step: Step | undefined): string {
  if (!step?.run) throw new Error("The selected workflow step must execute its preflight");
  return step.run;
}
const intentScript = script(workflow.jobs["publication-intent"]?.steps.find((step) => step.id === "intent"));
const configurationScript = script(workflow.jobs["release-configuration"]?.steps[0]);
const productionScript = script(workflow.jobs.production?.steps[0]);

// Execute the workflow's Bash, not a TypeScript imitation. Only external GitHub
// metadata and Git commit evidence are replaced; no real credentials are inherited.
function execute(command: string, overrides: Record<string, string> = {}, version = "1.2.3") {
  const directory = mkdtempSync(join(tmpdir(), "release-configuration-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    mkdirSync(join(directory, "packages/core"), { recursive: true });
    writeFileSync(join(directory, "packages/core/package.json"), JSON.stringify({ version }));
    const calls = join(directory, "calls");
    const output = join(directory, "outputs");
    writeFileSync(calls, "");
    writeFileSync(output, "");
    const executable = (name: string, body: string) =>
      writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
    executable(
      "gh",
      `printf 'gh %s\\n' "$*" >> "$CALLS"
[[ "$*" == 'api --include repos/fixture/armada/releases/tags/v1.2.3' ]] || exit 90
if [[ "$HTTP_STATUS" == network ]]; then exit 1; fi
printf 'HTTP/2 %s\\n\\n{}\\n' "$HTTP_STATUS"
[[ "$HTTP_STATUS" == 200 ]]`,
    );
    executable(
      "git",
      `printf 'git %s\\n' "$*" >> "$CALLS"
case "$*" in
  'rev-parse HEAD') printf '%s\\n' 'head-commit' ;;
  'rev-parse refs/tags/v1.2.3^{commit}')
    [[ "$TAG_EXISTS" == true ]] || exit 1
    printf '%s\\n' "$TAG_COMMIT" ;;
  'merge-base --is-ancestor HEAD origin/main') [[ "$ANCESTOR" == true ]] ;;
  *) exit 91 ;;
esac`,
    );
    const result = Bun.spawnSync(["bash", "-eu", "-c", command], {
      cwd: directory,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: directory,
        CALLS: calls,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
        EVENT_NAME: "push",
        SOURCE_REF: "refs/heads/main",
        RELEASE_TAG: "",
        REQUESTED_PUBLISH: "false",
        GH_REPO: "fixture/armada",
        GH_TOKEN: "metadata-only-canary",
        HTTP_STATUS: "200",
        TAG_EXISTS: "true",
        TAG_COMMIT: "head-commit",
        ANCESTOR: "true",
        ...overrides,
      },
    });
    return {
      code: result.exitCode,
      output: readFileSync(output, "utf8"),
      calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
      message: result.stdout.toString() + result.stderr.toString(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("main publication intent distinguishes missing releases from published releases and metadata failures", () => {
  for (const [status, expected] of [
    ["200", "publish=false\n"],
    ["404", "publish=true\n"],
    ["503", ""],
    ["network", ""],
  ] as const) {
    const result = execute(intentScript, { HTTP_STATUS: status });
    expect(result.code).toBe(expected ? 0 : 1);
    expect(result.output).toBe(expected);
    expect(result.calls).toEqual(["gh api --include repos/fixture/armada/releases/tags/v1.2.3"]);
    expect(result.message).toBe(
      expected ? "" : "::error::Cannot verify release publication intent; no publication authorized.\n",
    );
    expect(result.message).not.toContain("metadata-only-canary");
  }
});

test("tag and explicit manual publication require the existing version tag to point at a main ancestor", () => {
  for (const event of ["push", "workflow_dispatch"]) {
    const result = execute(intentScript, {
      EVENT_NAME: event,
      SOURCE_REF: event === "push" ? "refs/tags/v1.2.3" : "refs/heads/main",
      RELEASE_TAG: "v1.2.3",
      REQUESTED_PUBLISH: "true",
    });
    expect(result.code).toBe(0);
    expect(result.output).toBe("publish=true\n");
    expect(result.calls).toEqual([
      "git rev-parse HEAD",
      "git rev-parse refs/tags/v1.2.3^{commit}",
      "git merge-base --is-ancestor HEAD origin/main",
    ]);
    expect(result.message).toBe("");
  }
});

test("unsafe refs, missing or mismatched tag evidence, and invalid versions never authorize publication", () => {
  for (const overrides of [
    { SOURCE_REF: "refs/heads/feature" },
    { RELEASE_TAG: "" },
    { RELEASE_TAG: "v9.9.9" },
    { TAG_EXISTS: "false" },
    { TAG_COMMIT: "another-commit" },
    { ANCESTOR: "false" },
  ]) {
    const result = execute(intentScript, {
      EVENT_NAME: "workflow_dispatch",
      SOURCE_REF: "refs/heads/main",
      RELEASE_TAG: "v1.2.3",
      REQUESTED_PUBLISH: "true",
      ...overrides,
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toBe("");
    expect(result.calls.some((call) => call.startsWith("gh "))).toBe(false);
    expect(result.message).toContain("::error::");
  }
  const invalidVersion = execute(intentScript, {}, "not-a-version");
  expect(invalidVersion.code).toBe(1);
  expect(invalidVersion.calls).toEqual([]);
  expect(invalidVersion.output).toBe("");
});

test("manual dry runs need neither a tag, GitHub metadata nor deployment secrets", () => {
  const result = execute(intentScript, {
    EVENT_NAME: "workflow_dispatch",
    SOURCE_REF: "refs/heads/feature",
    REQUESTED_PUBLISH: "false",
    GH_TOKEN: "",
  });
  expect(result.code).toBe(0);
  expect(result.output).toBe("publish=false\n");
  expect(result.calls).toEqual([]);
  expect(result.message).toBe("");
});

const commonNames = [
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
  "ARMADA_SERVER_URL",
];
const stagingNames = ["ARMADA_SMOKE_TOKEN", "ARMADA_SMOKE_CASES", "ARMADA_ORIGIN"];
const commonValues = Object.fromEntries(commonNames.map((key) => [key, "private-configuration-canary"]));
const stagingValues = Object.fromEntries(stagingNames.map((key) => [key, "private-staging-canary"]));

test("release preflight lists all missing names once without disclosing any configuration values", () => {
  for (const role of ["staging", "production"]) {
    const result = execute(configurationScript, { RELEASE_ENVIRONMENT: role });
    const names = role === "staging" ? [...commonNames, ...stagingNames] : commonNames;
    expect(result.code).toBe(1);
    expect(result.message).toBe(`::error::Missing release configuration (${role}): ${names.join(" ")}\n`);
    expect(result.output).toBe("");
    expect(result.calls).toEqual([]);
  }
});

test("staging requires its smoke token, cases and origin in addition to common deployment configuration", () => {
  const result = execute(configurationScript, { RELEASE_ENVIRONMENT: "staging", ...commonValues });
  expect(result.code).toBe(1);
  expect(result.message).toBe(`::error::Missing release configuration (staging): ${stagingNames.join(" ")}\n`);
  expect(result.message).not.toContain("private-configuration-canary");
});

test("complete release configuration succeeds silently for each environment", () => {
  for (const role of ["staging", "production"]) {
    const result = execute(configurationScript, {
      RELEASE_ENVIRONMENT: role,
      ...commonValues,
      ...(role === "staging" ? stagingValues : {}),
    });
    expect(result.code).toBe(0);
    expect(result.message).toBe("");
    expect(result.output).toBe("");
    expect(result.calls).toEqual([]);
  }
});

test("release preflight rejects an unsupported environment before credentials or external commands", () => {
  const result = execute(configurationScript, {
    RELEASE_ENVIRONMENT: "preview",
    ...commonValues,
    ...stagingValues,
  });
  expect(result.code).toBe(1);
  expect(result.message).toBe("::error::Unsupported release configuration environment.\n");
  expect(result.calls).toEqual([]);
});

test("the production consumer rechecks its configuration in its actual first step", () => {
  for (const missing of [false, true]) {
    const result = execute(productionScript, {
      RELEASE_ENVIRONMENT: "production",
      ...commonValues,
      ...(missing ? { SUPABASE_DB_PASSWORD: "", VERCEL_TOKEN: "" } : {}),
    });
    expect(result.code).toBe(missing ? 1 : 0);
    expect(result.message).toBe(
      missing ? "::error::Missing release configuration (production): SUPABASE_DB_PASSWORD VERCEL_TOKEN\n" : "",
    );
    expect(result.output).toBe("");
    expect(result.calls).toEqual([]);
  }
});

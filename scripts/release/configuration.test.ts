import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
type Job = {
  steps: Step[];
  needs?: string | string[];
  outputs?: Record<string, string>;
  env?: Record<string, string>;
};
const workflow = Bun.YAML.parse(
  readFileSync(resolve(import.meta.dir, "../../.github/workflows/release.yml"), "utf8"),
) as { jobs: Record<string, Job> };

function script(step: Step | undefined): string {
  if (!step?.run) throw new Error("The selected workflow step must execute its preflight");
  return step.run;
}
const configurationScript = script(workflow.jobs["release-configuration"]?.steps[0]);
const productionScript = script(workflow.jobs.production?.steps[0]);

// Execute the workflow preflight without inheriting real credentials.
function execute(command: string, overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "release-configuration-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const calls = join(directory, "calls");
    const output = join(directory, "outputs");
    writeFileSync(calls, "");
    writeFileSync(output, "");
    const result = Bun.spawnSync(["bash", "-eu", "-c", command], {
      cwd: directory,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: directory,
        CALLS: calls,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
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

test("binary and publish jobs use the validated release version for npm artifacts", () => {
  const binary = workflow.jobs.binary;
  const publish = workflow.jobs.publish;
  if (!binary || !publish) throw new Error("Missing binary or publish job");

  const collection = binary.steps.find((step) => step.name === "Collect smoke-tested npm tarballs");
  const artifact = binary.steps.find((step) => step.with?.path === "dist/npm-artifact");
  const download = publish.steps.find((step) => step.with?.path === "dist/tarballs");
  const version = `\${{ needs.release-metadata.outputs.version }}`;

  expect(workflow.jobs["release-metadata"]?.outputs?.version).toBeTruthy();
  expect(binary.needs).toContain("release-metadata");
  expect(publish.needs).toContain("release-metadata");
  expect(collection?.env?.VERSION).toBe(version);
  expect(publish.env?.VERSION).toBe(version);
  const sha = `\${{ needs.release-metadata.outputs.sha }}`;
  expect(artifact?.with?.name).toBe(`npm-tarballs-${version}-${sha}-\${{ matrix.target }}`);
  expect(download?.with?.pattern).toBe(`npm-tarballs-${version}-${sha}-*`);
});

const verifiedPublish = workflow.jobs.publish?.steps.find((step) => step.id === "verified-npm-publish");

test.each(["intact", "tampered", "incomplete artifact"])("npm verifies tarballs before publish (%s)", (scenario) => {
  const directory = mkdtempSync(join(tmpdir(), "release-tarballs-"));
  try {
    const tarballDir = join(directory, "dist/tarballs");
    mkdirSync(tarballDir, { recursive: true });
    const toolsDir = join(directory, ".release-tools/scripts");
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(join(toolsDir, "publish-npm.sh"), 'printf "publish %s\\n" "$@"\n');

    const version = "1.2.3";
    const prefix = "the-vibe-company-armada";
    for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
      const packages =
        target === "linux-x64" ? [`${prefix}-${target}`, prefix, `${prefix}-sdk`] : [`${prefix}-${target}`];
      const entries = packages.flatMap((name) => {
        const filename = `${name}-${version}.tgz`;
        if (name === prefix && scenario === "incomplete artifact") return [];
        writeFileSync(join(tarballDir, filename), name === prefix && scenario === "tampered" ? "changed" : name);
        return [`${new Bun.CryptoHasher("sha256").update(name).digest("hex")}  ${filename}\n`];
      });
      writeFileSync(join(tarballDir, `SHA256SUMS-${target}`), entries.join(""));
    }

    const result = Bun.spawnSync(["bash", "-c", script(verifiedPublish)], {
      cwd: directory,
      env: { PATH: "/usr/bin:/bin", VERSION: version },
    });
    if (scenario === "intact") {
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim().split("\n")).toHaveLength(6);
    } else {
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).not.toContain("publish ");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

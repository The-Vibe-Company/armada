import { appendFileSync, writeFileSync } from "node:fs";

export function publicationMode(status: number, tagSha: string, sha: string, recovery: boolean) {
  if (status !== 200 && status !== 404) throw new Error("Cannot verify GitHub release metadata");
  if ((tagSha && tagSha !== sha && (recovery || status === 404)) || (status === 200 && !tagSha)) {
    throw new Error("The version tag does not match the requested release source");
  }
  if (status === 404) return "candidate";
  return recovery ? "recover" : "prepare";
}

export function promotionRequired(published: boolean, stableDigest: string, smokedDigest: string) {
  if (stableDigest === smokedDigest) return false;
  if (published) throw new Error("Published image differs from the smoked image");
  return true;
}

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { stdin: "ignore", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${args[0]} ${args[1]} failed`);
  return result.stdout.toString().trim();
}

function versionAt(ref: string): string {
  const { version } = JSON.parse(command("git", "show", `${ref}:packages/core/package.json`));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Publication requires a stable version");
  }
  return version;
}

function releaseStatus(version: string) {
  const result = Bun.spawnSync(["gh", "api", "--include", `repos/{owner}/{repo}/releases/tags/v${version}`], {
    stderr: "ignore",
  });
  const status = Number(/^HTTP\/\S+ (\d+)/.exec(result.stdout.toString())?.[1]);
  if (status === 200 && result.exitCode !== 0) throw new Error("Cannot verify GitHub release metadata");
  return status;
}

function tagSha(version: string) {
  const result = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/tags/v${version}^{commit}`]);
  if (result.exitCode === 1) return "";
  if (result.exitCode !== 0) throw new Error("Cannot resolve release tag");
  return result.stdout.toString().trim();
}

function releasePr(sha: string) {
  const merge = command(
    "git",
    "log",
    "-1",
    "--first-parent",
    "--diff-merges=first-parent",
    "--format=%H",
    "--no-patch",
    "-G",
    '"version":',
    sha,
    "--",
    "packages/core/package.json",
  );
  if (!merge) throw new Error("Cannot locate version change");
  type Pull = {
    number: number;
    body: string | null;
    merged_at: string | null;
    merge_commit_sha: string;
    head: { ref: string; repo: { full_name: string } | null };
    base: { ref: string };
    labels: { name: string }[];
  };
  const pulls = JSON.parse(command("gh", "api", `repos/{owner}/{repo}/commits/${merge}/pulls`)) as Pull[];
  const matches = pulls.filter(
    (pr) =>
      pr.merged_at &&
      pr.merge_commit_sha === merge &&
      pr.base.ref === "main" &&
      pr.head.repo?.full_name === process.env.GH_REPO &&
      /^release-please--branches--main(?:--components--.+)?$/.test(pr.head.ref),
  );
  if (matches.length !== 1 || !matches[0]) throw new Error("Cannot identify the merged version PR");
  return { merge, pr: matches[0] };
}

function requireLatest(version: string) {
  const latest = command("git", "tag", "--list", "v*", "--sort=-version:refname")
    .split("\n")
    .find((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  if (latest && latest !== `v${version}` && Bun.semver.order(latest.slice(1), version) > 0) {
    throw new Error(`Release superseded by ${latest}`);
  }
}

function reconcile(version: string, sha: string) {
  if (releaseStatus(version) !== 200 || tagSha(version) !== sha) throw new Error("Cannot verify published release");
  const { pr } = releasePr(sha);
  const endpoint = `repos/{owner}/{repo}/issues/${pr.number}/labels`;
  if (!pr.labels.some(({ name }) => name === "autorelease: tagged")) {
    command("gh", "api", "--method", "POST", endpoint, "-f", "labels[]=autorelease: tagged");
  }
  if (pr.labels.some(({ name }) => name === "autorelease: pending")) {
    command("gh", "api", "--method", "DELETE", `${endpoint}/autorelease%3A%20pending`);
  }
}

function main() {
  const {
    GITHUB_OUTPUT,
    SOURCE_SHA = "",
    REQUESTED_VERSION = "",
    REQUESTED_SHA = "",
    RUN_MODE = "",
    VERSION = "",
    RELEASE_SHA = "",
    SMOKED_DIGEST = "",
    STABLE_DIGEST = "",
    RUNNER_TEMP,
  } = process.env;
  const output = (key: string, value: string) => {
    if (!GITHUB_OUTPUT) throw new Error("Missing job output path");
    appendFileSync(GITHUB_OUTPUT, `${key}=${value}\n`);
  };
  const action = process.argv[2];
  if (action === "admit") {
    if (RUN_MODE === "dry-run") {
      output("sha", SOURCE_SHA);
      output("mode", "dry-run");
      output("publish", "false");
      return;
    }
    const recovery = RUN_MODE === "dispatch";
    if (recovery && !/^[a-f0-9]{40}$/.test(REQUESTED_SHA)) throw new Error("Supply a full commit SHA");
    const sha = recovery ? REQUESTED_SHA : command("git", "rev-parse", "origin/main");
    const version = versionAt(sha);
    command("git", "merge-base", "--is-ancestor", sha, "origin/main");
    if (recovery && version !== REQUESTED_VERSION) throw new Error("Requested version differs from source");
    const status = releaseStatus(version);
    const publishedSha = tagSha(version);
    const mode =
      !recovery && version !== versionAt(SOURCE_SHA)
        ? "superseded"
        : publicationMode(status, publishedSha, sha, recovery);
    if (mode !== "superseded") releasePr(mode === "prepare" ? publishedSha : sha);
    if (mode === "candidate" || mode === "recover") requireLatest(version);
    output("sha", mode === "prepare" ? publishedSha : sha);
    output("version", version);
    output("mode", mode);
    output("publish", String(mode === "candidate" || mode === "recover"));
  } else if (action === "reconcile") {
    reconcile(VERSION, RELEASE_SHA);
  } else if (action === "finalize") {
    requireLatest(VERSION);
    command("git", "merge-base", "--is-ancestor", RELEASE_SHA, "origin/main");
    const mode = publicationMode(releaseStatus(VERSION), tagSha(VERSION), RELEASE_SHA, true);
    if (mode === "candidate" && versionAt("origin/main") !== VERSION) {
      throw new Error("Main moved to a different release version");
    }
    const { pr, merge } = releasePr(RELEASE_SHA);
    if (!RUNNER_TEMP) throw new Error("Missing runner temp path");
    const notes = [pr.body ?? ""];
    if (merge !== RELEASE_SHA) {
      const changes = command("git", "log", "--first-parent", "--format=- %s (%h)", `${merge}..${RELEASE_SHA}`);
      notes.push(
        `## Changes after the version PR\n\n${changes}\n\n${process.env.GITHUB_SERVER_URL}/${process.env.GH_REPO}/compare/${merge}...${RELEASE_SHA}`,
      );
    }
    writeFileSync(`${RUNNER_TEMP}/release-notes.md`, notes.join("\n\n"));
    output("create", String(mode === "candidate"));
    output("promote", String(promotionRequired(mode === "recover", STABLE_DIGEST, SMOKED_DIGEST)));
  } else {
    throw new Error("Unknown publication operation");
  }
}

if (import.meta.main) main();

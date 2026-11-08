import { expect, test } from "bun:test";
import { GOLDEN_ROOT, GoldenError } from "../src/golden-config.ts";
import { resolveLaunchWorkdir } from "../src/launch-workdir.ts";

const repos = [
  { url: "https://github.com/acme/repo-a.git", branch: "main", dir: "repo-a" },
  { url: "git@github.com:acme/repo-b.git", branch: "main", dir: "repo-b" },
] as const;

test("selects the recorded owner/repo workdir", () => {
  expect(resolveLaunchWorkdir(repos, "ACME/repo-b").cwd).toBe(`${GOLDEN_ROOT}/repo-b`);
});

test("rejects unknown, ambiguous, and invalid recorded repository directories", () => {
  expect(() => resolveLaunchWorkdir(repos, "acme/missing")).toThrow(GoldenError);
  expect(() => resolveLaunchWorkdir([...repos, { ...repos[0], dir: "copy" }], "acme/repo-a")).toThrow("ambiguous");
  expect(() => resolveLaunchWorkdir([{ ...repos[0], dir: "../escape" }], "acme/repo-a")).toThrow(
    "directory is invalid",
  );
});

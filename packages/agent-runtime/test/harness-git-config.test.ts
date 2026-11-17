import { expect, test } from "bun:test";
import { privateHarnessHome } from "../src/exec-env.ts";

const harnesses: ("claude" | "codex" | "opencode")[] = ["claude", "codex", "opencode"];
const token = "fixture_github_credential";

// Launch writes identity and the credential helper with `git config --global` through exec.
// Every harness must resolve that same global file despite its private HOME (#2577).
test.each(harnesses)("%s keeps the exec Git global config and GitHub env under its private HOME", (harness) => {
  const modalExec = { HOME: "/home/user", GIT_CONFIG_GLOBAL: "/home/user/.gitconfig", GH_TOKEN: token };
  const env: Record<string, string> = { HOME: "/home/user", GH_TOKEN: token, GITHUB_TOKEN: token };
  expect(privateHarnessHome("/runtime", harness, env, modalExec)).toBe(`/runtime/${harness}/home`);
  expect(env).toEqual({
    HOME: `/runtime/${harness}/home`,
    XDG_CONFIG_HOME: `/runtime/${harness}/home/.config`,
    XDG_CACHE_HOME: `/runtime/${harness}/home/.cache`,
    XDG_DATA_HOME: `/runtime/${harness}/home/.local/share`,
    GIT_CONFIG_GLOBAL: "/home/user/.gitconfig",
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  });
});

// Managed tools write the helper to the exec HOME first (main.ts `homes[0]`).
test("without an explicit exec Git config, a harness reads the exec HOME config", () => {
  const env: Record<string, string> = {};
  privateHarnessHome("/runtime", "codex", env, { HOME: "/workspace/home" });
  expect(env.GIT_CONFIG_GLOBAL).toBe("/workspace/home/.gitconfig");
});

test("without an exec HOME, a harness reads the runtime process HOME config", () => {
  const env: Record<string, string> = {};
  privateHarnessHome("/runtime", "claude", env, {}, "/home/user");
  expect(env.GIT_CONFIG_GLOBAL).toBe("/home/user/.gitconfig");
});

test("an explicit harness Git config is kept", () => {
  const env: Record<string, string> = { GIT_CONFIG_GLOBAL: "/srv/harness.gitconfig" };
  privateHarnessHome("/runtime", "opencode", env, { GIT_CONFIG_GLOBAL: "/home/user/.gitconfig" });
  expect(env.GIT_CONFIG_GLOBAL).toBe("/srv/harness.gitconfig");
});

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

test("without an explicit exec Git config, harnesses share the exec HOME config the managed tools write", () => {
  const managed: Record<string, string> = {};
  privateHarnessHome("/runtime", "codex", managed, { HOME: "/workspace/home" });
  expect(managed.GIT_CONFIG_GLOBAL).toBe("/workspace/home/.gitconfig");
  const fallback: Record<string, string> = {};
  privateHarnessHome("/runtime", "claude", fallback, {}, "/home/user");
  expect(fallback.GIT_CONFIG_GLOBAL).toBe("/home/user/.gitconfig");
  const explicit: Record<string, string> = { GIT_CONFIG_GLOBAL: "/srv/harness.gitconfig" };
  privateHarnessHome("/runtime", "opencode", explicit, { GIT_CONFIG_GLOBAL: "/home/user/.gitconfig" });
  expect(explicit.GIT_CONFIG_GLOBAL).toBe("/srv/harness.gitconfig");
});

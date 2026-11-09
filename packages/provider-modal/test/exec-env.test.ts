import { expect, test } from "bun:test";
import { type ExecEnvironment, projectGitHubExecEnvironment, withTrustedHarnessPath } from "../src/index.ts";

test("exec projection never copies a model/fork environment wholesale and resolver output is authoritative", () => {
  const projected = projectGitHubExecEnvironment({
    GH_TOKEN: "synthetic-gh",
    GITHUB_TOKEN: "synthetic-gh",
    OPENAI_API_KEY: "model-only",
    ANTHROPIC_API_KEY: "model-only",
    MODAL_TOKEN_SECRET: "management-only",
    HOME: "/untrusted/home",
    PATH: "/untrusted/path",
  });
  expect(projected).toEqual({
    GH_TOKEN: "synthetic-gh",
    GITHUB_TOKEN: "synthetic-gh",
    HOME: "/home/user",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/home/user/.gitconfig",
    GIT_TERMINAL_PROMPT: "0",
  });
  expect(projectGitHubExecEnvironment({ GH_TOKEN: "must-not-enable" }, {})).not.toHaveProperty("GH_TOKEN");
  expect(() => projectGitHubExecEnvironment({}, { OPENAI_API_KEY: "must-not-allow" } as ExecEnvironment)).toThrow();
  expect(() => projectGitHubExecEnvironment({ GH_TOKEN: "bad\ntoken" })).toThrow();
});

test("both native model environments get an explicit tool PATH, with trusted path-only overrides", () => {
  expect(withTrustedHarnessPath({ OPENAI_API_KEY: "synthetic-model" })).toEqual({
    OPENAI_API_KEY: "synthetic-model",
    PATH: "/usr/local/bin:/usr/bin:/bin",
  });
  expect(withTrustedHarnessPath({ PATH: "/home/user/tools:/usr/local/bin:/usr/bin:/bin" }).PATH).toBe(
    "/home/user/tools:/usr/local/bin:/usr/bin:/bin",
  );
  expect(() => withTrustedHarnessPath({ PATH: "https://user:credential@example.invalid" })).toThrow();
  expect(() => withTrustedHarnessPath({ PATH: "relative:/usr/bin" })).toThrow();
});

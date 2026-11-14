import { expect, test } from "bun:test";
import { validateExecEnvironment, validateExecReadables } from "../src/exec-env.ts";
import { githubRuntimeEnvironment } from "../src/github-tools.ts";

test("managed GitHub environment reserves its private shell hook and gives shims precedence", () => {
  const root = "/home/user/runtime/github-epoch";
  const env = githubRuntimeEnvironment({ PATH: "/usr/bin:/bin" }, root);
  expect(env).toEqual({ PATH: `${root}/bin:/usr/bin:/bin`, BASH_ENV: `${root}/shell-env.sh` });
  expect(githubRuntimeEnvironment(env, root)).toEqual(env);
  expect(githubRuntimeEnvironment({ PATH: `/usr/bin:${root}/bin:/bin` }, root)).toEqual(env);
  expect(() => githubRuntimeEnvironment({}, "relative-root")).toThrow("github_tools_denied");
});

test("the private GitHub shell bootstrap does not open a user-controlled BASH_ENV channel", () => {
  expect(() => validateExecEnvironment({ BASH_ENV: "/tmp/untrusted" })).toThrow("invalid_exec_environment");
  expect(() => validateExecReadables({ BASH_ENV: "/tmp/untrusted" })).toThrow();
});

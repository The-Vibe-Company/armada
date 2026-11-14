import { expect, test } from "bun:test";
import { validateExecEnvironment, validateExecReadables } from "../src/exec-env.ts";
import { githubRuntimeEnvironment, githubShellEnvironmentScript } from "../src/github-tools.ts";

test("managed GitHub tools survive login-shell PATH reset without credentials or duplicate prefixes", () => {
  const root = "/home/user/runtime/github-epoch";
  const env = githubRuntimeEnvironment({ PATH: "/usr/bin:/bin" }, root);
  expect(env).toEqual({ PATH: `${root}/bin:/usr/bin:/bin`, BASH_ENV: `${root}/shell-env.sh` });
  expect(githubRuntimeEnvironment(env, root)).toEqual(env);
  expect(githubRuntimeEnvironment({ PATH: `/usr/bin:${root}/bin:/bin` }, root)).toEqual(env);
  // This is the emitted shell bootstrap artifact, not a production-source grep.
  expect(githubShellEnvironmentScript(root)).toBe(
    `case "\${PATH-}" in '${root}/bin'|'${root}/bin':*) ;; *) export PATH='${root}/bin':"\${PATH-/usr/local/bin:/usr/bin:/bin}" ;; esac\n`,
  );
  expect(() => githubRuntimeEnvironment({}, "relative-root")).toThrow("github_tools_denied");
});

test("the private GitHub shell bootstrap does not open a user-controlled BASH_ENV channel", () => {
  expect(() => validateExecEnvironment({ BASH_ENV: "/tmp/untrusted" })).toThrow("invalid_exec_environment");
  expect(() => validateExecReadables({ BASH_ENV: "/tmp/untrusted" })).toThrow();
});

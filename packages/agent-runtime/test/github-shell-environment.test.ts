import { expect, test } from "bun:test";
import { shellQuote } from "../../core/src/shell-quote.ts";
import { validateExecEnvironment, validateExecReadables } from "../src/exec-env.ts";
import { githubToolCommands } from "../src/github-client.ts";
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

test("runtime GitHub shims and credential helper invoke Bun without a golden interpreter", () => {
  const socket = "/home/user/managed tools/credentials.sock";
  const git = "/usr/bin/git";
  const gh = "/usr/bin/gh";
  const self = [process.execPath, process.argv[1]!, "github-client"].map(shellQuote).join(" ");
  expect(githubToolCommands(socket, git, gh)).toEqual({
    git: `${self} 'git-run' ${shellQuote(socket)} '/usr/bin/git'`,
    gh: `${self} 'gh' ${shellQuote(socket)} '/usr/bin/gh' '/usr/bin/git'`,
    credential: `!${self} 'git' ${shellQuote(socket)}`,
    native: `${self} 'native' '/home/user/managed tools/redact.sock'`,
  });
});

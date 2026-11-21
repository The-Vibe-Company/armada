import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../../core/src/shell-quote.ts";
import { validateExecEnvironment, validateExecReadables } from "../src/exec-env.ts";
import { githubToolCommands } from "../src/github-client.ts";
import { githubRuntimeEnvironment, prepareGitHubTools } from "../src/github-tools.ts";

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
  const execPath = "/opt/armada/runtime executable";
  const entry = "/opt/armada/main.js";
  for (const [entrypoint, args] of [
    ["/$bunfs/root/main", [execPath]],
    [entry, [execPath, "--config=/dev/null", "--no-env-file", entry]],
  ] as const) {
    const invocation = [...args, "github-client"].map(shellQuote).join(" ");
    const self = `unset BUN_BE_BUN BUN_OPTIONS NODE_OPTIONS BUN_CONFIG_VERBOSE_FETCH; exec ${invocation}`;
    expect(githubToolCommands(socket, git, gh, { execPath, argv: [execPath, entrypoint] })).toEqual({
      git: `${self} 'git-run' ${shellQuote(socket)} '/usr/bin/git'`,
      gh: `${self} 'gh' ${shellQuote(socket)} '/usr/bin/gh' '/usr/bin/git'`,
      credential: `!${self} 'git' ${shellQuote(socket)}`,
      native: `${self} 'native' '/home/user/managed tools/redact.sock'`,
    });
  }
});

test("privileged GitHub setup preserves Git if provisioning leaves system Python unusable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "github-python-"));
  const git = join(directory, "git");
  // oxlint-disable-next-line landmines-testing/no-test-doubles -- Exercise the privileged installer without requiring the test runner to be root.
  const uid = spyOn(process, "getuid").mockReturnValue(0);
  // oxlint-disable-next-line landmines-testing/no-test-doubles -- Simulate an unavailable guest interpreter without invoking host APT.
  const spawn = spyOn(Bun, "spawn").mockImplementation((args) => {
    const packageRepair = Array.isArray(args) && args[0] === "/bin/sh";
    return { exited: Promise.resolve(packageRepair ? 0 : 1) } as unknown as ReturnType<typeof Bun.spawn>;
  });
  try {
    await writeFile(git, "original git");
    await expect(
      prepareGitHubTools({
        root: join(directory, "broker"),
        activation: "offline",
        socket: join(directory, "missing-socket"),
        git,
        gitWrapper: git,
        gh: join(directory, "gh"),
        ghWrapper: join(directory, "gh"),
        homes: [],
      }),
    ).rejects.toThrow();
    expect(await readFile(git, "utf8")).toBe("original git");
    expect(spawn).toHaveBeenCalledTimes(3);
  } finally {
    spawn.mockRestore();
    uid.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

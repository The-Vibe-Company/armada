import { expect, test } from "bun:test";
import { HARNESSES, VERSION } from "@armada/core";
import { run } from "../src/run.ts";

for (const command of [
  "--help",
  "api",
  "new",
  "events",
  "ls",
  "rm",
  "info",
  "stop",
  "report",
  "prompt",
  "exec",
  "outputs",
  "template",
  "snapshot",
  "snapshot new",
  "account",
  "account import claude",
  "account add",
]) {
  test(`armada ${command} help preserves its output`, async () => {
    async function help(flag: string) {
      const argv =
        command === "--help"
          ? [flag]
          : command === "events"
            ? [command, flag]
            : ["--profile", "new-user", ...command.split(" "), flag];
      const fail = () => {
        throw new Error("Help must not perform authenticated or secret I/O");
      };
      let stdout = "";
      const code = await run(
        argv,
        { out: (text) => (stdout += text), err: fail },
        {
          env: {},
          auth: {
            env: {},
            out: fail,
            err: fail,
            now: fail,
            open: fail,
            fetch: fail,
            session: { read: fail, write: fail, clear: fail },
            preferences: { read: fail, write: fail },
          },
          fetch: Object.assign(fail, { preconnect: fail }),
          readFile: fail,
          readStdin: fail,
        },
      );
      expect(code).toBe(0);
      return stdout;
    }
    const stdout = await help("--help");
    expect(await help("-h")).toBe(stdout);
    if (command === "--help") {
      expect(stdout.startsWith(`armada ${VERSION}: `)).toBe(true);
    }
    if (command === "new" || command === "--help") {
      const launchAgentLists = [...stdout.matchAll(/^(?: +|Usage: )armada new .*?--agent ([\w|-]+)/gm)].map(
        ([, agents]) => agents,
      );
      expect(launchAgentLists).toEqual([HARNESSES.join("|"), HARNESSES.join("|")]);
    }
    if (command === "ls") {
      expect(stdout).toContain(`use only one (${HARNESSES.join(" or ")}).`);
    }
    expect(command === "--help" ? stdout.replace(`armada ${VERSION}: `, "armada VERSION: ") : stdout).toMatchSnapshot();
  });
}

test("host help shows the five host commands", async () => {
  let stdout = "";
  const fail = () => {
    throw new Error("Help must not perform authenticated or secret I/O");
  };
  const code = await run(
    ["host", "--help"],
    { out: (text) => (stdout += text), err: fail },
    { env: {}, fetch: Object.assign(fail, { preconnect: fail }) },
  );
  expect(code).toBe(0);
  expect([...stdout.matchAll(/^ {2}(\w+) +\S/gm)].map((match) => match[1])).toEqual([
    "install",
    "add",
    "ls",
    "limits",
    "rm",
  ]);
});

test("events help rejects an invalid profile from the environment", async () => {
  let stderr = "";
  const fail = () => {
    throw new Error("Invalid profile must not print help or make a request");
  };
  const code = await run(
    ["events", "--help"],
    { out: fail, err: (text) => (stderr += text) },
    { env: { ARMADA_PROFILE: "bad.profile" }, fetch: Object.assign(fail, { preconnect: fail }) },
  );
  expect(code).toBe(2);
  expect(stderr).toContain("Profile names must be 1–64");
});

test.each(["snapshot", "account"])("bare %s prints focused family help", async (command) => {
  let stdout = "";
  const fail = () => {
    throw new Error("Family help must not perform authenticated or secret I/O");
  };
  const code = await run(
    ["--profile", "new-user", command],
    { out: (text) => (stdout += text), err: fail },
    { env: {}, fetch: Object.assign(fail, { preconnect: fail }) },
  );
  expect(code).toBe(0);
  expect(stdout).toStartWith(`Usage: armada ${command} `);
});

test.each([
  [["snapshot", "new", "name", "--help"], "armada snapshot new --help"],
  [["account", "add", "--help", "--unknown"], "armada account add --help"],
] as const)("%j leaves malformed help requests to the operation parser", async (argv, hint) => {
  let stderr = "";
  const fail = () => {
    throw new Error("The parser must reject this operation before any output or I/O");
  };
  const code = await run(
    argv,
    { out: fail, err: (text) => (stderr += text) },
    { env: {}, fetch: Object.assign(fail, { preconnect: fail }), readStdin: fail },
  );
  expect(code).toBe(2);
  expect(stderr).toBe(`armada: Unknown option '--help'.\nNext step: run ${hint}.\n`);
});

test("grouped --help, bare armada, help <cmd>, trailing --help, and unconfigured skill help stay offline", async () => {
  const fail = () => {
    throw new Error("Help must stay offline");
  };
  const capture = async (argv: string[]) => {
    let out = "",
      err = "";
    const code = await run(
      argv,
      { out: (t) => (out += t), err: (t) => (err += t) },
      { env: {}, fetch: Object.assign(fail, { preconnect: fail }), readStdin: fail },
    );
    return { code, out, err };
  };
  const bare = await capture([]);
  expect(bare.code).toBe(0);
  expect(bare.err).toBe("");
  for (const section of [
    "Sandboxes:",
    "Interactive & Relay:",
    "Templates & Snapshots:",
    "Hosts & Accounts:",
    "Auth & API:",
  ])
    expect(bare.out).toContain(section);
  expect(await capture(["--help"])).toEqual(bare);

  expect((await capture(["help", "ls"])).out).toStartWith("Usage: armada ls ");
  expect((await capture(["help", "snapshot", "new"])).out).toStartWith("Usage: armada snapshot new ");
  expect((await capture(["help", "skill", "install"])).out).toStartWith("Usage: armada skill install ");
  expect((await capture(["help", "unknown"])).code).toBe(2);

  expect((await capture(["ls", "--json", "--help"])).out).toStartWith("Usage: armada ls ");
  expect((await capture(["new", "--provider", "modal", "--help"])).out).toStartWith("Usage: armada new ");
  expect((await capture(["--profile", "unconfigured", "skill", "install", "--help"])).out).toStartWith(
    "Usage: armada skill install ",
  );
});

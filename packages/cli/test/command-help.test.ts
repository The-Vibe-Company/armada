import { expect, test } from "bun:test";
import { VERSION } from "@armada/core";
import { run } from "../src/run.ts";

for (const command of [
  "--help",
  "launch",
  "logs",
  "list",
  "advice",
  "rm",
  "extend",
  "status",
  "detail",
  "recovery",
  "stop",
  "interrupt",
  "wait",
  "report",
  "send",
  "steer",
  "exec",
]) {
  test(`armada ${command} help preserves its output`, async () => {
    async function help(flag: string) {
      const argv =
        command === "--help" ? [flag] : command === "logs" ? [command, flag] : ["--profile", "new-user", command, flag];
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
    expect(command === "--help" ? stdout.replace(`armada ${VERSION}: `, "armada VERSION: ") : stdout).toMatchSnapshot();
  });
}

test("logs help rejects an invalid profile from the environment", async () => {
  let stderr = "";
  const fail = () => {
    throw new Error("Invalid profile must not print help or make a request");
  };
  const code = await run(
    ["logs", "--help"],
    { out: fail, err: (text) => (stderr += text) },
    { env: { ARMADA_PROFILE: "bad.profile" }, fetch: Object.assign(fail, { preconnect: fail }) },
  );
  expect(code).toBe(2);
  expect(stderr).toContain("Profile names must be 1–64");
});

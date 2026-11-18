import { expect, test } from "bun:test";
import { VERSION } from "@armada/core";
import { run } from "../src/run.ts";

for (const command of [
  "--help",
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
      const argv = command === "--help" ? [flag] : ["--profile", "new-user", command, flag];
      const fail = () => {
        throw new Error("Help must not perform authenticated or secret I/O");
      };
      let stdout = "";
      const code = await run(
        argv,
        { out: (text) => (stdout += text), err: fail },
        {
          env: {},
          fetch: fail,
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

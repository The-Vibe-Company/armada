import { describe, expect, test } from "bun:test";
import { VERSION } from "@armada/core";
import { run } from "../src/run.ts";

async function capture(argv: string[]) {
  let out = "";
  let err = "";
  const code = await run(argv, { out: (text) => (out += text), err: (text) => (err += text) });
  return { code, out, err };
}

describe("run", () => {
  test("--version prints the version alone", async () => {
    expect(await capture(["--version"])).toEqual({ code: 0, out: `${VERSION}\n`, err: "" });
  });

  test("no command prints the help", async () => {
    const { code, out } = await capture([]);
    expect(code).toBe(0);
    expect(out).toContain("armada golden create");
    expect(out).toContain("armada launch <golden> --agent claude|codex");
    expect(out).toContain("armada login");
    expect(out).toContain("armada token create");
  });

  test.each([
    "launch",
    "list",
    "detail",
    "status",
    "advice",
    "bind-credential",
    "rm",
    "extend",
    "report",
    "send",
    "steer",
    "exec",
    "stop",
    "wait",
    "interrupt",
    "logs",
    "mcp",
    "login",
    "logout",
    "token",
    "org",
    "account",
    "github",
    "creds",
  ])("%s help needs no login or server request", async (command) => {
    const { code, out, err } = await capture([command, "--help"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain(`armada ${command}`);
  });

  test("an unknown command fails with a usage error", async () => {
    const { code, out, err } = await capture(["frobnicate"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("unknown command 'frobnicate'");
  });
});

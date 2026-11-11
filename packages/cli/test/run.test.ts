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
    "recovery",
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
    expect(out).toContain("Usage:");
    expect(out).toContain(command);
  });

  test.each(["--help", "-h"])("logs %s explains the reader without login, preferences or requests", async (option) => {
    let out = "";
    let err = "";
    const forbidden = async () => {
      throw new Error("Help must not perform I/O");
    };
    const io = {
      out: (text: string) => {
        out += text;
      },
      err: (text: string) => {
        err += text;
      },
    };
    const code = await run(["logs", option], io, {
      auth: {
        ...io,
        env: {},
        now: () => new Date(0),
        open: forbidden,
        fetch: forbidden,
        session: { read: forbidden, write: forbidden, clear: forbidden },
        preferences: { read: forbidden, write: forbidden },
      },
    });
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("armada logs");
    expect(out).toContain("--since");
    expect(out).toContain("--org");
    expect(out).toContain("1–1000");
    expect(out).toContain("default 100");
    expect(out).toContain("cannot combine");
    expect(out).toContain(".events[]");
    expect(out).toContain("Ctrl-C");
    expect(out).not.toContain("armada golden create");
  });

  test("an unknown command fails with a usage error", async () => {
    const { code, out, err } = await capture(["frobnicate"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("unknown command 'frobnicate'");
  });
});

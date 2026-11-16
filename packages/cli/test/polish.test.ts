import { expect, test } from "bun:test";
import { AuthError } from "@armada/auth";
import { HARNESSES } from "@armada/core";
import { agentHint } from "../src/agent-hint.ts";
import { COMMANDS, HELP } from "../src/command-catalog.ts";
import { completion } from "../src/devx.ts";
import { failureHint } from "../src/failure-hint.ts";
import { run } from "../src/run.ts";

test("completion includes every documented command and option in every shell", () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    let output = "";
    completion([shell], {
      out: (text) => {
        output += text;
      },
    });
    for (const command of [...COMMANDS, "detail", "recovery", "stop", "interrupt", "send", "steer", "exec", "golden"])
      expect(output).toContain(command);
    for (const option of HELP.match(/--[a-z][a-z-]*/g) ?? [])
      expect(output).toContain(shell === "fish" ? `-l ${option.slice(2)}` : option);
  }
});
test("recovery hints follow auth, usage, deployment and uncertain outcome classes", () => {
  expect(failureHint(new AuthError("expired", "unauthorized"), ["list"], {})).toContain("armada login");
  expect(failureHint(new AuthError("expired", "unauthorized"), ["list"], { ARMADA_TOKEN: "fixture" })).toContain(
    "replace ARMADA_TOKEN",
  );
  expect(failureHint(new AuthError("bad flag", "usage"), ["list"], {})).toContain("armada list --help");
  expect(failureHint(new Error("does not serve /api/v1/org/list"), ["org"], {})).toContain("administrator");
  expect(failureHint(new Error("operation may have been accepted"), ["launch"], {})).toContain("before retrying");
});
test("agent guidance lists every accepted harness", () => {
  for (const harness of HARNESSES) expect(agentHint()).toContain(harness);
});
test("bare families provide login-free discovery on stdout", async () => {
  for (const family of [
    "template",
    "routine",
    "vars",
    "secrets",
    "host",
    "snapshot",
    "golden",
    "mcp",
    "creds",
    "org",
    "account",
    "github",
    "token",
    "skill",
  ]) {
    let out = "",
      err = "";
    expect(
      await run(
        [family],
        {
          out: (text) => {
            out += text;
          },
          err: (text) => {
            err += text;
          },
        },
        { env: {} },
      ),
    ).toBe(0);
    expect(out).toContain("armada");
    expect(err).toBe("");
  }
});

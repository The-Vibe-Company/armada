import { expect, spyOn, test } from "bun:test";
import { ChildOwner } from "../src/children.ts";
import { validateExecEnvironment, validateExecReadables } from "../src/exec-env.ts";
import { Journal } from "../src/journal.ts";
import { AUTH_HEADER } from "../src/protocol.ts";
import { Runner } from "../src/runtime.ts";

// Private readable projection must survive the actual guest constructor without
// opening the credential/control environment to arbitrary values. No processes.
test("guest execution admits separate readable configuration, including empty values, without relaxing exec controls", () => {
  const readables = { APP_REGION: "eu-west", EMPTY_VALUE: "" };
  expect(validateExecReadables(readables)).toEqual(readables);
  expect(() => validateExecEnvironment(readables)).toThrow("invalid_exec_environment");
  const journal = new Journal(":memory:", (value) => value);
  try {
    const grant = { token: "offline-exec-readables", sandboxId: "s", generation: "1", expiresAt: Date.now() + 60000 };
    expect(
      () =>
        new Runner(journal, grant, {}, undefined, undefined, undefined, {
          execEnv: { HOME: "/home/user", PATH: "/usr/bin:/bin" },
          readableVariables: readables,
        }),
    ).not.toThrow();
    for (const variables of [
      { HOME: "/tmp" },
      { OPENAI_API_KEY: "secret" },
      { GIT_CONFIG_GLOBAL: "/tmp/git" },
      { GIT_TERMINAL_PROMPT: "1" },
      { APP_REGION: "bad\0value" },
    ]) {
      expect(() => validateExecReadables(variables)).toThrow();
      expect(
        () => new Runner(journal, grant, {}, undefined, undefined, undefined, { readableVariables: variables }),
      ).toThrow();
    }
    expect(() => validateExecReadables(readables, true)).toThrow("invalid_exec_readables");
  } finally {
    journal.close();
  }
});

test("sandbox exec does not inherit template readable variables", async () => {
  const journal = new Journal(":memory:", (value) => value);
  const grant = { token: "offline-exec-readables", sandboxId: "s", generation: "1", expiresAt: Date.now() + 60000 };
  const spawn = spyOn(ChildOwner.prototype, "spawn").mockImplementation(() => {
    throw Error("fixture stops before spawning");
  });
  try {
    const runner = new Runner(journal, grant, {}, undefined, undefined, undefined, {
      execEnv: { HOME: "/home/user" },
      readableVariables: { APP_REGION: "eu-west", EMPTY_VALUE: "" },
    });
    await runner.handle(
      new Request("https://runner", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({
          version: 1,
          requestId: "exec-isolation",
          sandboxId: grant.sandboxId,
          op: "exec",
          input: { sandboxId: grant.sandboxId, command: "env" },
        }),
      }),
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    const env = spawn.mock.calls[0]?.[2].env;
    expect(env?.HOME).toBe("/home/user");
    expect(env).not.toHaveProperty("APP_REGION");
    expect(env).not.toHaveProperty("EMPTY_VALUE");
  } finally {
    spawn.mockRestore();
    journal.close();
  }
});

import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

test("command boundaries reject recognized but unused flags before making requests", async () => {
  const invocations = [
    ...["info", "prompt", "exec", "stop", "report", "bind-credential"].map((command) => [
      command,
      "sandbox",
      "--ttl",
      "4h",
    ]),
    ...["ls", "new", "update", "rebuild", "rm", "show"].map((command) => ["snapshot", command, "--ttl", "4h"]),
    ["stop", "sandbox", "--turn", "--after"],
    ["stop", "sandbox", "--timeout", "60"],
    ["report", "sandbox", "ready", "--reason", "ignored"],
    ["report", "sandbox", "blocked", "--pr-number", "1"],
    ["account", "status", "--timeout", "4"],
    ["account", "logout", "--private"],
    ["account", "ls", "github", "--timeout", "4"],
    ["account", "login", "github", "--ttl", "4h"],
  ];
  for (const argv of invocations) {
    let requests = 0;
    let stderr = "";
    const auth = {
      env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture_session" },
      session: memorySessionStore(),
      now: () => new Date(0),
      open: () => {},
      out: () => {},
      err: (text: string) => {
        stderr += text;
      },
      fetch: async () => {
        requests++;
        return Response.json({});
      },
    };
    expect(await run([...argv, "--json"], auth, { auth })).toBe(2);
    expect(requests).toBe(0);
    expect(JSON.parse(stderr).error.code).toBe("invalid_config");
  }
});

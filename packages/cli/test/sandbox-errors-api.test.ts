import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const id = "11111111-1111-4111-8111-111111111111";
const canary = "synthetic-private-provider-detail";
async function capture(args: string[], status: number, serverCode: unknown) {
  let out = "";
  let err = "";
  let calls = 0;
  const auth = {
    env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture-token" },
    session: memorySessionStore(),
    now: () => new Date(),
    open: () => {},
    out: (s: string) => {
      out += s;
    },
    err: (s: string) => {
      err += s;
    },
    fetch: async () => {
      calls++;
      return Response.json({ error: { code: serverCode, message: canary, details: { reason: canary } } }, { status });
    },
  };
  const exit = await run(args, auth, { auth });
  expect(calls).toBe(1);
  expect(out).toBe("");
  expect(err).not.toContain(canary);
  return { exit, err };
}

// One owner at run.ts: the routes have different parsing and legacy code mappings.
test.each([
  ["status", id],
  ["detail", id],
  ["recovery", id],
  ["advice", id],
  ["wait", id],
  ["logs", id],
  ["stop", id],
  ["interrupt", id],
  ["send", id, "hello"],
  ["steer", id, "hello"],
  ["exec", id, "printf audit"],
  ["rm", id, "--yes"],
  ["report", id, "blocked", "--prompt-id", id, "--reason", "audit"],
  ["bind-credential", id, "--credential-id", id],
])("missing sandbox gets actionable not_found and a legacy code: %s", async (...args) => {
  const { exit, err } = await capture([...args, "--json"], 404, "not_found");
  expect(exit).toBe(1);
  const failure = JSON.parse(err).error;
  expect(failure.code).toBe("not_found");
  expect(failure.legacyCode).toBe(
    ["recovery", "advice", "report", "bind-credential"].includes(args[0] ?? "") ? "unavailable" : "conflict",
  );
  expect(failure.message).toContain("not found or not accessible");
  expect(failure.message).toContain("armada list --json");
  expect(failure.message).not.toContain("Outcome unknown");
});

test.each([
  [400, "invalid_request", "invalid_request", "unavailable", 2, "COMMAND --help"],
  [403, "forbidden", "forbidden", "conflict", 1, "org admin"],
  [409, "conflict", "conflict", "unavailable", 1, "start/stop"],
  [409, "no_running_turn", "no_running_turn", "unavailable", 1, "armada send"],
  [409, "sandbox_not_ready", "sandbox_not_ready", "unavailable", 1, "Wait until"],
  [400, "unsupported", "unsupported", "unavailable", 1, "not supported"],
  [500, "internal", "unavailable", undefined, 1, "may already have been accepted"],
  [400, canary, "invalid_request", "unavailable", 2, "COMMAND --help"],
])("sandbox HTTP %s / %s keeps a closed reason and next step", async (status, server, code, legacy, exit, step) => {
  const result = await capture(["steer", id, "hello", "--json"], status as number, server);
  expect(result.exit).toBe(exit);
  const failure = JSON.parse(result.err).error;
  expect(failure.code).toBe(code);
  expect(failure.legacyCode).toBe(legacy);
  expect(failure.message).toContain(step as string);
});

test("human error guidance is stderr-only and does not retry a stop rejection", async () => {
  const result = await capture(["stop", id], 409, "conflict");
  expect(result.exit).toBe(1);
  expect(result.err).toStartWith("armada: The sandbox state conflicts");
  expect(result.err).toContain("armada list --json");
  expect(result.err).not.toContain("Outcome unknown");
});

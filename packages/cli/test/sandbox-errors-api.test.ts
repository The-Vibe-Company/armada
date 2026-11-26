import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const id = "11111111-1111-4111-8111-111111111111";
const canary = "synthetic-private-provider-detail";
async function capture(args: string[], status: number, serverCode: unknown, message = canary, stdoutIsTTY?: boolean) {
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
      return Response.json({ error: { code: serverCode, message, details: { reason: canary } } }, { status });
    },
  };
  const exit = await run(args, auth, { auth, ...(stdoutIsTTY === undefined ? {} : { stdoutIsTTY }) });
  expect(calls).toBe(1);
  expect(out).toBe("");
  expect(err).not.toContain(canary);
  return { exit, err };
}

test.each(
  [
    ["info", id],
    ["info", id, "--wait"],
    ["events", id],
    ["stop", id],
    ["stop", id, "--turn"],
    ["prompt", id, "hello"],
    ["prompt", "--steer", id, "hello"],
    ["exec", id, "--", "printf audit"],
    ["rm", id, "--yes"],
    ["report", id, "blocked", "--prompt-id", id, "--reason", "audit"],
    ["bind-credential", id, "--credential-id", id],
  ].map((args) => ({ args })),
)("missing sandbox gets actionable not_found: $args", async ({ args }) => {
  const { exit, err } = await capture(args, 404, "not_found", canary, false);
  expect(exit).toBe(1);
  const failure = JSON.parse(err).error;
  expect(failure.code).toBe("not_found");
  expect(failure.message).toContain("not found or not accessible");
  expect(failure.message).toContain("armada ls --json");
  expect(failure.message).not.toContain("Outcome unknown");
});

test.each([
  [400, "invalid_request", "invalid_request", 2, "COMMAND --help"],
  [403, "forbidden", "forbidden", 1, "org admin"],
  [409, "conflict", "conflict", 1, "start/stop"],
  [409, "no_running_turn", "no_running_turn", 1, "armada prompt"],
  [409, "sandbox_not_ready", "sandbox_not_ready", 1, "Wait until"],
  [400, "unsupported", "unsupported", 1, "not supported"],
  [500, "internal", "unavailable", 1, "may already have been accepted"],
  [400, canary, "invalid_request", 2, "COMMAND --help"],
])("sandbox HTTP %s / %s keeps a closed reason and next step", async (status, server, code, exit, step) => {
  const msg = server === "invalid_request" ? "" : canary;
  const result = await capture(["prompt", "--steer", id, "hello", "--json"], status as number, server, msg);
  expect(result.exit).toBe(exit);
  const failure = JSON.parse(result.err).error;
  expect(failure.code).toBe(code);
  expect(failure.message).toContain(step as string);
});

test("sandbox 400 invalid_request preserves specific server validation message and hides internal issue refs", async () => {
  const validation = await capture(
    ["info", id, "--json"],
    400,
    "invalid_request",
    "request_id is supported only for runtime control.",
  );
  expect(validation.exit).toBe(2);
  expect(JSON.parse(validation.err).error.message).toBe("request_id is supported only for runtime control.");
  expect((await capture(["info", id, "--json"], 409, "credential_binding_unsupported")).err).not.toContain("#1579");
});

test("human error guidance is stderr-only and does not retry a stop rejection", async () => {
  const result = await capture(["stop", id], 409, "conflict");
  expect(result.exit).toBe(1);
  expect(result.err).toStartWith("armada: The sandbox state conflicts");
  expect(result.err).toContain("armada ls --json");
  expect(result.err).not.toContain("Outcome unknown");
});

test.each(["provider_unavailable", "dependency_unavailable", "outcome_unknown"])(
  "stop gives outcome guidance for %s",
  async (code) => {
    const result = await capture(["stop", id, "--json"], 503, code);
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.err).error).toMatchObject({ code });
    expect(JSON.parse(result.err).error.message).toContain("armada ls --json");
  },
);

test.each(["", canary])("binding refusal preserves only an exact fixed reason (suffix=%s)", async (suffix) => {
  const message = "The workspace was bound concurrently; no account change was made.";
  const result = await capture(
    ["bind-credential", id, "--credential-id", id, "--json"],
    409,
    "conflict",
    message + suffix,
  );
  const failure = JSON.parse(result.err).error;
  expect(result.exit).toBe(1);
  if (!suffix) {
    expect(failure.message).toContain(message);
    expect(failure.message).toContain("armada info ID");
  } else {
    expect(failure.message).not.toContain(message);
    expect(failure.message).toContain("armada ls --json");
  }
});

test.each([
  { args: ["new", "web", "--provider", "boat", "--agent", "codex", "hello"] },
  { args: ["prompt", id, "hello"] },
])("host_full remains actionable without relaying provider diagnostics: $args", async ({ args }) => {
  const result = await capture([...args, "--json"], 409, "host_full");
  expect(result.exit).toBe(1);
  const failure = JSON.parse(result.err).error;
  expect(failure.code).toBe("host_full");
  expect(failure.message).toContain("Stop a sandbox on that host or raise its limit");
  expect(failure.message).not.toContain("outcome unknown");
});

test("terminal send reports the exact shared recovery reason and rejects appended guest text", async () => {
  const message =
    "Cannot control docker sandbox: stopped. Its container is removed after finish/stop; start a new sandbox on the same branch.";
  for (const code of ["sandbox_terminal", "invalid_request"])
    for (const suffix of ["", canary]) {
      const result = await capture(["prompt", id, "hello", "--json"], 409, code, message + suffix);
      expect(JSON.parse(result.err).error.message.startsWith(message)).toBe(suffix === "");
    }
});

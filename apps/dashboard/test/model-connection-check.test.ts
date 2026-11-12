import { expect, spyOn, test } from "bun:test";
import { createAccountControl } from "../src/lib/account-control";
import { controlPost } from "../src/lib/control";
import { connectionTestOutcome, matchesConnectionTestSandbox } from "../src/lib/model-connection-check";

const expected = { id: "sandbox", ownerId: "owner", orgId: "org", accountId: "account", version: 3 };
const row = {
  id: "sandbox",
  owner_id: "owner",
  org_id: "org",
  credential_id: "account",
  credential_version: 3,
  provider: "modal",
  status: "ready",
};

test("Models check accepts only the selected account/version in the viewer's running organization sandbox", () => {
  expect(matchesConnectionTestSandbox(row, expected)).toBe(true);
  for (const changed of [
    { owner_id: "other" },
    { org_id: "other" },
    { credential_id: "other" },
    { credential_version: 2 },
    { provider: "boat" },
    { status: "stopped" },
    { status: ["ready"] },
    { id: "other" },
  ])
    expect(matchesConnectionTestSandbox({ ...row, ...changed }, expected)).toBe(false);
  expect(matchesConnectionTestSandbox(null, expected)).toBe(false);
});

test("account check client sends no secret/config and closes untrusted result fields", async () => {
  let malformed = false;
  const control = createAccountControl({
    serverUrl: "https://armada.example/mcp",
    token: "synthetic-session",
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://armada.example/api/v1/sandbox/test-model-connection");
      expect(JSON.parse(String(init?.body))).toEqual({ id: "sandbox", model: "deployment", org: "org" });
      return Response.json({
        test: {
          ok: false,
          status: 401,
          error: "provider_rejected",
          code: malformed ? "private-diagnostic" : "invalid_api_key",
        },
      });
    },
  });
  const result = await control.testConnection({ id: "sandbox", model: "deployment", org: "org" });
  expect(connectionTestOutcome(result)).toEqual({ ok: false, error: "Connection rejected: HTTP 401 invalid_api_key." });
  malformed = true;
  await expect(control.testConnection({ id: "sandbox", model: "deployment", org: "org" })).rejects.toThrow(
    "invalid connection-test receipt",
  );
  expect(connectionTestOutcome({ ok: true, status: 200, error: null, code: null }).ok).toBe(true);
});

test("dashboard check's deadline includes the runtime's 15-second response", async () => {
  const timers: { ms: number; controller: AbortController }[] = [];
  const timer = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    timers.push({ ms, controller });
    return controller.signal;
  });
  const options = {
    serverUrl: "https://armada.example/mcp",
    token: "synthetic-session",
    fetch: async (_input: string | URL | Request, init?: RequestInit) => {
      for (const entry of timers) if (entry.ms <= 15000) entry.controller.abort();
      init?.signal?.throwIfAborted();
      return Response.json({ test: { ok: false, status: null, error: "connection_failed", code: null } });
    },
  };
  try {
    // The old generic-budget call cannot carry a response arriving at fifteen seconds.
    await expect(controlPost(options, "/api/v1/sandbox/test-model-connection", {}, "checks")).rejects.toThrow();
    const result = await createAccountControl(options).testConnection({
      id: "sandbox",
      model: "deployment",
      org: "org",
    });
    expect(result).toEqual({ ok: false, status: null, error: "connection_failed", code: null });
  } finally {
    timer.mockRestore();
  }
});

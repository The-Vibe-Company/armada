import { expect, spyOn, test } from "bun:test";
import { LaunchError, ProviderError } from "@armada/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callSharedTool, ToolApiError } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";

function context(error: Error): ToolContext {
  return {
    caller: { userId: "owner", orgs: [{ orgId: "org", role: "member" }], via: "service" },
    data: {
      sandboxes: {
        get: async () => ({
          id: "sandbox",
          ownerId: "owner",
          orgId: "org",
          provider: "boat",
          providerSandboxId: "bx",
          status: "running",
        }),
      },
    },
    provider: async () => ({ id: "boat", get: async () => ({ state: "running" }) }),
    launchCredentials: {
      refreshGitHub: async () => {
        throw error;
      },
    },
    logError: () => {},
    now: () => new Date(),
  } as unknown as ToolContext;
}

// Real MCP serialization and shared operation dispatch, not a mocked decoder result.
test.each([
  {
    error: new LaunchError("start_failed", "Private skill installation failed.", {
      skillFailure: { reason: "skillpack_install_nonzero", stage: "install" },
    }),
    details: { reason: "skillpack_install_nonzero", stage: "install" },
    status: 502,
  },
  {
    error: new LaunchError("unsupported", "Rebuild the golden.", {
      helperRefusal: { reason: "helper_missing", action: "rebuild_golden" },
    }),
    details: { reason: "helper_missing", action: "rebuild_golden" },
    status: 400,
  },
  {
    error: new LaunchError("outcome_unknown", "Check status before retrying."),
    details: undefined,
    status: 503,
  },
])("shared tool preserves $error.code diagnostics and public status", async ({ error, details, status }) => {
  try {
    await callSharedTool(context(error), "github_refresh", { id: "sandbox" });
    throw new Error("Expected a tool failure");
  } catch (caught) {
    expect(caught).toBeInstanceOf(ToolApiError);
    expect(caught).toMatchObject({
      code: error.code,
      message:
        error.code === "start_failed"
          ? "The sandbox could not start. Check its recorded status, correct the provider setup and launch again."
          : error.message,
      status,
    });
    expect((caught as ToolApiError).details).toEqual(details);
  }
});

// Hostile wire input tests the trust boundary separately from the real round trip.
test.each([
  {
    details: { reason: "helper_missing", action: "rebuild_golden", secret: "private" },
    expected: { reason: "helper_missing", action: "rebuild_golden" },
  },
  { details: { reason: "arbitrary-private-text", stage: "install" }, expected: undefined },
  { details: { reason: "helper_missing", action: "arbitrary-private-text" }, expected: undefined },
  { details: { reason: "helper_missing", stage: "arbitrary-private-text" }, expected: undefined },
])("bridge only copies closed launch detail fields: $details", async ({ details, expected }) => {
  const wire = spyOn(Client.prototype, "callTool").mockResolvedValue({
    isError: true,
    structuredContent: { error: { code: "outcome_unknown", message: "Check status before retrying.", details } },
    content: [
      { type: "text", text: "legacy message" },
      { type: "text", text: "error code: internal" },
    ],
  });
  try {
    await expect(callSharedTool(context(new Error()), "github_refresh", { id: "sandbox" })).rejects.toMatchObject({
      code: "outcome_unknown",
      message: "Check status before retrying.",
      status: 503,
      details: expected,
    });
  } finally {
    wire.mockRestore();
  }
});

test("bridge falls back to legacy text when structured code/message is invalid", async () => {
  const wire = spyOn(Client.prototype, "callTool").mockResolvedValue({
    isError: true,
    structuredContent: { error: { code: {}, message: 42, details: { reason: "helper_missing" } } },
    content: [
      { type: "text", text: "Legacy refusal." },
      { type: "text", text: "error code: forbidden" },
    ],
  });
  try {
    await expect(callSharedTool(context(new Error()), "github_refresh", { id: "sandbox" })).rejects.toMatchObject({
      code: "forbidden",
      message: "Legacy refusal.",
      status: 403,
      details: undefined,
    });
  } finally {
    wire.mockRestore();
  }
});

test("start failures log missing-relation causes without changing the public error", async () => {
  const logs: string[] = [];
  const error = new LaunchError("start_failed", "The sandbox could not be started.", {
    cause: new Error('relation "public.skill_defaults" does not exist'),
  });
  const ctx = context(error);
  ctx.logError = (line) => logs.push(line);
  await expect(callSharedTool(ctx, "github_refresh", { id: "sandbox" })).rejects.toMatchObject({
    code: "start_failed",
    message: "The sandbox could not start. Check its recorded status, correct the provider setup and launch again.",
  });
  expect(logs).toHaveLength(1);
  expect(JSON.parse(logs[0] ?? "")).toMatchObject({
    event: "operator_failure",
    phase: "tool.github_refresh",
    message: 'relation "public.skill_defaults" does not exist',
  });

  // Only identifier-shaped schema drift survives; free text in the same shape stays withheld.
  logs.length = 0;
  const unsafe = new LaunchError("start_failed", "The sandbox could not be started.", {
    cause: new Error('relation "pw=hunter two" does not exist'),
  });
  const unsafeCtx = context(unsafe);
  unsafeCtx.logError = (line) => logs.push(line);
  await expect(callSharedTool(unsafeCtx, "github_refresh", { id: "sandbox" })).rejects.toMatchObject({
    code: "start_failed",
  });
  expect(logs).toHaveLength(1);
  expect(JSON.parse(logs[0] ?? "")).toMatchObject({ message: "Exception message withheld" });
  expect(logs[0]).not.toContain("hunter");
});

test("provider start-limit reset survives the real MCP to HTTP bridge", async () => {
  const error = new ProviderError({
    provider: "boat",
    code: "rate_limited",
    status: 429,
    retryable: true,
    message: "private_diagnostic",
    details: { provider: "boat", window: "day", nextStartAt: "2026-11-17T00:00:00.000Z", secret: "private_diagnostic" },
  });
  await expect(callSharedTool(context(error), "github_refresh", { id: "sandbox" })).rejects.toMatchObject({
    code: "rate_limited",
    status: 429,
    details: { provider: "boat", window: "day", nextStartAt: "2026-11-17T00:00:00.000Z" },
  });
});

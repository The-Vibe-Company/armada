import { expect, spyOn, test } from "bun:test";
import { LaunchError } from "@armada/core";
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
    status: 400,
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
    expect(caught).toMatchObject({ code: error.code, message: error.message, status });
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

import { expect, test } from "bun:test";
import { GITHUB_REFRESH_MODAL_NATIVE } from "@armada/core";
import { dispatchGitHubRestControl } from "../src/github-rest-controls.ts";
import type { ToolContext } from "../src/tools.ts";

// Exercise the REST handler with the real request and response schemas.
// It protects owner-only injection into running machines without model credentials.
test.each([
  { caller: "owner", state: "running", providerId: "boat", expected: "connected" },
  { caller: "admin", state: "running", providerId: "boat", expected: "forbidden" },
  { caller: "owner", state: "stopped", providerId: "boat", expected: "conflict" },
  { caller: "owner", state: "running", providerId: "modal", expected: "unsupported" },
])("legacy GitHub repair authorizes $caller on $providerId $state", async ({ caller, state, providerId, expected }) => {
  const calls: unknown[] = [];
  const context = repairContext(
    caller,
    state,
    async (...args: unknown[]) => {
      calls.push(args);
      return { login: "octocat" };
    },
    providerId,
  );
  const provider = await context.provider({} as never);
  if (expected === "connected") {
    expect(await dispatchGitHubRestControl(context, "github/refresh", { id: "sandbox" })).toEqual({
      id: "sandbox",
      login: "octocat",
      status: "connected",
    });
    expect(calls).toEqual([[{ userId: "owner", orgId: "org", role: "member" }, provider, "bx"]]);
  } else {
    await expect(dispatchGitHubRestControl(context, "github/refresh", { id: "sandbox" })).rejects.toMatchObject({
      code: expected,
      ...(expected === "unsupported" ? { status: 400, message: GITHUB_REFRESH_MODAL_NATIVE } : {}),
    });
    expect(calls).toEqual([]);
  }
});

function repairContext(
  caller: string,
  state: string,
  refreshGitHub: () => Promise<{ login: string }>,
  providerId = "boat",
): ToolContext {
  const provider = { id: providerId, get: async () => ({ state }) };
  return {
    caller: { userId: caller, orgs: [{ orgId: "org", role: "admin" }], via: "service" },
    data: {
      sandboxes: {
        get: async () => ({
          id: "sandbox",
          ownerId: "owner",
          orgId: "org",
          provider: providerId,
          credentialId: "credential",
          providerSandboxId: "bx",
          status: "running",
        }),
      },
    },
    provider: async () => provider,
    launchCredentials: {
      refreshGitHub,
    },
    now: () => new Date(),
  } as unknown as ToolContext;
}

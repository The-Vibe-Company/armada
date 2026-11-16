import { expect, test } from "bun:test";
import type { Provider } from "@armada/core";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";

for (const operation of ["steer", "interrupt", "exec"] as const) {
  test(`${operation} forwards runtime request identity, rejects native identity and enforces ownership`, async () => {
    const requests: unknown[] = [];
    const sandbox = {
      id: "sandbox",
      ownerId: "owner",
      orgId: "org",
      provider: "boat",
      providerSandboxId: "physical",
      status: "running",
      harness: "claude",
      boatRuntime: true,
    };
    const provider = {
      id: "boat",
      capabilities: { claude: { steer: "native", interrupt: true } },
      [operation]: async (request: unknown) => {
        requests.push(request);
        return operation === "steer"
          ? { promptId: "prompt", conversationId: "conversation" }
          : { detached: false, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
      },
    } as unknown as Provider;
    const context = {
      caller: { userId: "owner", orgs: [{ orgId: "org", role: "member" }], via: "service" },
      data: { sandboxes: { get: async () => sandbox } },
      provider: async () => provider,
      exposedSecrets: async () => [],
      now: () => new Date(),
    } as unknown as ToolContext;
    const args = {
      id: "sandbox",
      request_id: "11111111-1111-4111-8111-111111111111",
      ...(operation === "steer" ? { text: "Continue" } : {}),
      ...(operation === "exec" ? { command: "pwd" } : {}),
    };
    await callSharedTool(context, operation, args);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ sandboxId: "physical", requestId: args.request_id });
    sandbox.boatRuntime = false;
    await expect(callSharedTool(context, operation, args)).rejects.toMatchObject({ code: "invalid_request" });
    sandbox.boatRuntime = true;
    sandbox.ownerId = "other";
    await expect(callSharedTool(context, operation, args)).rejects.toMatchObject({ code: "forbidden" });
    expect(requests).toHaveLength(1);
  });
}

import { expect, mock, test } from "bun:test";
import { ORCHESTRATOR_SCOPED_PATH } from "@armada/core/contract";
import { observeRequest } from "../src/request-observability.ts";
import { createSandboxScopedGateway } from "../src/sandbox-access-scoped-gateway.ts";

for (const transport of ["mcp", "rest"] as const) {
  test(`scoped ${transport} unexpected failures retain an operator cause and a public request ID`, async () => {
    const privateMessage = "Unfiltered upstream failure detail";
    const fail = async () => {
      throw Object.assign(new Error(privateMessage), { code: "ECONNRESET" });
    };
    const configureMutationRequest = mock((_request: Request) => {});
    const route = createSandboxScopedGateway(
      {
        message: fail,
        launch: fail,
        read: fail,
        extend: fail,
        stop: fail,
        reconcileOne: fail,
        drain: fail,
        stopAdmission() {},
      },
      { catalogGrant: fail },
      undefined,
      undefined,
      configureMutationRequest,
    );
    const args = { sandboxId: crypto.randomUUID(), text: "hello" };
    const key = "message-fixture";
    const request = new Request(
      `https://armada.example.com${ORCHESTRATOR_SCOPED_PATH}/${transport === "mcp" ? "mcp" : "message"}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer armada_epoch_${"a".repeat(64)}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(
          transport === "mcp"
            ? {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "message", arguments: { ...args, idempotencyKey: key } },
              }
            : args,
        ),
      },
    );
    const logs: string[] = [];
    const response = await observeRequest(
      async () => (await route(request)) ?? new Response(null, { status: 404 }),
      (line) => logs.push(line),
    );
    expect(configureMutationRequest).toHaveBeenCalledWith(request);
    const requestId = response?.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    expect(response?.status).toBe(transport === "mcp" ? 200 : 503);
    const body = await response?.text();
    expect(body).not.toContain(privateMessage);
    expect(body).not.toContain("ECONNRESET");
    if (transport === "mcp") {
      expect(JSON.parse(body ?? "").result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "scoped_operation_unavailable" }],
        _meta: { requestId },
      });
    } else {
      expect(JSON.parse(body ?? "")).toEqual({
        error: { code: "scoped_operation_unavailable", message: "scoped_operation_unavailable" },
      });
    }
    expect(logs.join("\n")).not.toContain(privateMessage);
    const failures = logs.map((line) => JSON.parse(line)).filter((line) => line.event === "operator_failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      phase: `scoped.${transport}.message`,
      requestId,
      message: "ECONNRESET",
    });
  });
}

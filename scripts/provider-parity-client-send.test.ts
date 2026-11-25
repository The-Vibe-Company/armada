import { expect, test } from "bun:test";
import { parityRequest, sandboxDeletePath } from "./provider-parity-delete.fixture.ts";
import { providerParitySmoke } from "./provider-parity-smoke.ts";

// Owns real dashboard JSON-RPC and CLI command request paths, native correlation and cleanup.
for (const mode of [
  "valid",
  "dashboard_reject",
  "cli_reject",
  "cli_unauthorized",
  "dashboard_echo",
  "cli_stale",
  "cli_later_answer",
  "dashboard_late",
  "unsupported",
  "conversation_missing",
] as const) {
  test(`client send parity: ${mode}`, async () => {
    const orgs = { modal: "10000000-0000-4000-8000-000000000001", docker: "20000000-0000-4000-8000-000000000001" };
    const ids = { modal: "10000000-0000-4000-8000-000000000002", docker: "20000000-0000-4000-8000-000000000002" };
    const conversation = "recorded_conversation";
    const states = new Map<string, string>(),
      prompts = new Map<string, string>(),
      clients = new Map<string, string>(),
      reads = new Map<string, number>();
    const calls: string[] = [],
      lines: string[] = [],
      wire: Array<{ provider: string; client: string; body: Record<string, unknown> }> = [];
    let now = 0,
      active: "modal" | "docker" = "modal";
    const passed = await providerParitySmoke(
      {
        ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
        ARMADA_TOKEN: "placeholder",
        ARMADA_SMOKE: "create_real_compute",
        ARMADA_SMOKE_CASES: JSON.stringify(
          (["modal", "docker"] as const).map((provider) => ({
            provider,
            org: orgs[provider],
            harness: "codex",
            model: "fixture",
            modelAccountId: "40000000-0000-4000-8000-000000000001",
            golden: "golden",
            hostId: "30000000-0000-4000-8000-000000000001",
          })),
        ),
      },
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        out: (line) => lines.push(line),
        fetch: async (url, init) => {
          const body = parityRequest(url, init).body;
          const headers = new Headers(init.headers);
          expect(headers.get("authorization")).toBe("Bearer placeholder");
          const { path: route } = parityRequest(url, init);
          const provider = body.org ? (body.org === orgs.modal ? "modal" : "docker") : active;
          calls.push(`${provider}:${route}`);
          switch (route) {
            case "launch/options":
              return Response.json({
                providers: ["modal", "docker"].map((id) => ({
                  id,
                  harnesses: ["codex"],
                  capabilities: {
                    launch: true,
                    followupPrompts: mode !== "unsupported",
                    logs: true,
                    stop: true,
                    delete: true,
                  },
                  unsupportedReasons: { followupPrompts: "fixture unsupported" },
                })),
              });
            case "docker/hosts/list":
              return Response.json({ hosts: [{ id: "30000000-0000-4000-8000-000000000001", state: "online" }] });
            case "sandbox/launch":
              active = provider;
              states.set(provider, "ready");
              if (provider === "docker") return Response.json({ sandbox: { id: ids[provider], status: "starting" } });
              return Response.json({ sandbox: { id: ids[provider], provider, externalRef: body.externalRef } });
            case "sandbox/list":
              return Response.json({ sandboxes: [{ ...body, id: ids[provider], provider, status: "ready" }] });
            case "sandbox/status":
              return Response.json({
                id: body.id,
                status: states.get(provider),
                settled: true,
                prompt: null,
                conversationIds: mode === "conversation_missing" ? [] : [conversation],
              });
            case "sandbox/send": {
              if (String(body.prompt).includes("Remember this token")) {
                clients.set(provider, "seed");
                return Response.json({ promptId: `seed_${provider}` });
              }
              expect(body.id).toBe(ids[provider]);
              expect(body).not.toHaveProperty("conversation_id");
              expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);
              expect(body).not.toHaveProperty("model");
              expect(body).not.toHaveProperty("reasoning_effort");
              if (!body.org) {
                if (mode === "dashboard_late") now += 110_001;
                wire.push({ provider, client: "dashboard", body });
                if (mode === "dashboard_reject")
                  return Response.json(
                    { error: { code: "invalid_request_id", message: "private_error_placeholder" } },
                    { status: 400 },
                  );
                const promptId = `dashboard_${provider}`;
                prompts.set(promptId, String(body.prompt).match(/PARITY_CLIENT_DASHBOARD_[a-f0-9-]{36}/)![0]);
                clients.set(provider, "dashboard");
                return Response.json({ promptId });
              }
              expect(body.org).toBe(orgs[provider]);
              wire.push({ provider, client: "cli", body });
              if (mode === "cli_unauthorized")
                return Response.json(
                  { error: { code: "unauthorized", message: "private_error_placeholder" } },
                  { status: 401 },
                );
              if (mode === "cli_reject")
                return Response.json(
                  { error: { code: "sandbox_not_ready", message: "private_error_placeholder" } },
                  { status: 409 },
                );
              const promptId = `cli_${provider}`;
              prompts.set(promptId, String(body.prompt).match(/PARITY_CLIENT_CLI_[a-f0-9-]{36}/)![0]);
              clients.set(provider, "cli");
              return Response.json({ id: body.id, promptId, conversationId: conversation, status: "queued" });
            }
            case "logs/read": {
              const client = clients.get(provider)!;
              if (client === "seed")
                return Response.json({
                  events: [
                    { kind: "prompt", promptId: `seed_${provider}`, status: "finished" },
                    {
                      id: "seed_answer",
                      kind: "message",
                      promptId: `seed_${provider}`,
                      text: "SMOKE_OK",
                      partial: false,
                    },
                  ],
                });
              const promptId = `${client}_${provider}`;
              const n = (reads.get(promptId) ?? 0) + 1;
              reads.set(promptId, n);
              const answer = {
                id: "answer",
                at: 0,
                kind: "message",
                promptId: mode === "cli_stale" && client === "cli" ? `dashboard_${provider}` : promptId,
                text: prompts.get(promptId),
                partial: false,
                responseKind: mode === "dashboard_echo" && client === "dashboard" ? "tool_result" : "assistant",
              };
              return Response.json({
                cursor: `page_${n}`,
                settled: true,
                hasMore: mode === "cli_later_answer" && client === "cli" && n === 1,
                events: [
                  answer,
                  ...(mode === "cli_later_answer" && client === "cli" && n > 1
                    ? [{ ...answer, id: "later", text: "different final answer" }]
                    : []),
                  { id: "finished", at: 0, text: "", kind: "prompt", promptId, status: "finished" },
                ],
              });
            }
            case "sandbox/stop":
              states.set(provider, "stopped");
              return Response.json({ id: body.id, status: "stopped" });
            case sandboxDeletePath:
              states.set(provider, "deleted");
              return Response.json({ id: body.id, status: "deleted" });
            default:
              throw Error(`Unexpected ${route}`);
          }
        },
      },
      ["--feature", "client-send"],
    );
    expect(passed).toBe(["valid", "unsupported", "conversation_missing"].includes(mode));
    const report = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((value) => value?.step === "provider_parity");
    expect(report.starts).toBe(mode === "unsupported" ? 0 : 2);
    for (const provider of ["modal", "docker"] as const) {
      expect(report.features["client-send"][provider].status).toBe(
        mode === "valid"
          ? "pass"
          : mode === "unsupported"
            ? "unsupported"
            : mode === "conversation_missing"
              ? "not-run"
              : "fail",
      );
      if (mode !== "unsupported") expect(report.features.cleanup[provider].status).toBe("pass");
      if (mode === "valid") {
        expect(report.features["client-send-dashboard"][provider].status).toBe("pass");
        expect(report.features["client-send-cli"][provider].status).toBe("pass");
        expect(wire.filter((value) => value.provider === provider)).toHaveLength(2);
        expect(wire.filter((value) => value.provider === provider).map((value) => value.body.request_id)[0]).not.toBe(
          wire.filter((value) => value.provider === provider).map((value) => value.body.request_id)[1],
        );
      }
      if (mode === "dashboard_reject" || mode === "dashboard_echo" || mode === "dashboard_late")
        expect(wire.some((value) => value.provider === provider && value.client === "cli")).toBe(false);
      if (mode === "dashboard_reject")
        expect(report.features["client-send-dashboard"][provider].diagnostic.code).toBe("invalid_request_id");
      if (mode === "cli_unauthorized")
        expect(report.features["client-send-cli"][provider].diagnostic).toMatchObject({
          code: "unauthorized",
          httpStatus: 401,
        });
      if (mode === "cli_reject")
        expect(report.features["client-send-cli"][provider].diagnostic).toMatchObject({
          code: "sandbox_not_ready",
          httpStatus: 409,
        });
    }
    expect(lines.join("\n")).not.toContain("private_error_placeholder");
  });
}

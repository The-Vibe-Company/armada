import { expect, test } from "bun:test";
import { parityRequest, sandboxDeletePath } from "./provider-parity-delete.fixture.ts";
import { providerParitySmoke } from "./provider-parity-smoke.ts";

// Actual production client serializers, active/terminal observations and cleanup intent handling.
for (const mode of [
  "valid",
  "dashboard_refused",
  "cli_unauthorized",
  "ack_only",
  "wrong_ack",
  "lost_ack",
  "resume_quota",
  "unsupported",
  "late_stop",
  "post_status_refused",
] as const) {
  test(`client stop parity: ${mode}`, async () => {
    const org = { modal: "10000000-0000-4000-8000-000000000001", docker: "20000000-0000-4000-8000-000000000001" };
    const id = { modal: "10000000-0000-4000-8000-000000000002", docker: "20000000-0000-4000-8000-000000000002" };
    const states = new Map<string, string>(),
      memory = new Map<string, string>(),
      turns = new Map<string, number>(),
      deletes = new Map<string, number>(),
      cleanupStops = new Map<string, number>();
    const statusRefused = new Set<string>();
    const wire: Array<{ provider: string; client: string }> = [],
      lines: string[] = [];
    let now = 0,
      active: "modal" | "docker" = "modal";
    function stop(provider: "modal" | "docker", client: "dashboard" | "cli") {
      expect(["ready", "running"]).toContain(states.get(provider)!);
      wire.push({ provider, client });
      states.set(provider, mode === "ack_only" ? "stopping" : "stopped");
      if (mode === "late_stop") now += 110_001;
      if (mode === "lost_ack") throw Error("transport_placeholder");
      return { id: mode === "wrong_ack" ? "other_owned_placeholder" : id[provider], status: "stopped" };
    }
    const passed = await providerParitySmoke(
      {
        ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
        ARMADA_TOKEN: "placeholder",
        ARMADA_SMOKE: "create_real_compute",
        ARMADA_SMOKE_CASES: JSON.stringify(
          (["modal", "docker"] as const).map((provider) => ({
            provider,
            org: org[provider],
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
          const body = parityRequest(url, init).body,
            headers = new Headers(init.headers);
          expect(headers.get("authorization")).toBe("Bearer placeholder");
          const provider = body.org ? (body.org === org.modal ? "modal" : "docker") : active;
          const { path: route } = parityRequest(url, init);
          switch (route) {
            case "launch/options":
              return Response.json({
                providers: ["modal", "docker"].map((id) => ({
                  id,
                  harnesses: ["codex"],
                  capabilities: {
                    launch: true,
                    followupPrompts: true,
                    logs: true,
                    status: true,
                    stop: mode !== "unsupported",
                    resume: true,
                    delete: true,
                  },
                  unsupportedReasons: { stop: "fixture unsupported" },
                })),
              });
            case "docker/hosts/list":
              return Response.json({ hosts: [{ id: "30000000-0000-4000-8000-000000000001", state: "online" }] });
            case "sandbox/launch":
              active = provider;
              states.set(provider, "ready");
              if (provider === "docker") return Response.json({ sandbox: { id: id[provider], status: "starting" } });
              return Response.json({ sandbox: { id: id[provider], provider, externalRef: body.externalRef } });
            case "sandbox/send": {
              const n = (turns.get(provider) ?? 0) + 1;
              if (n > 1 && mode === "resume_quota")
                return Response.json({ error: { code: "rate_limited", message: "fixture quota" } }, { status: 429 });
              turns.set(provider, n);
              if (n === 1) memory.set(provider, String(body.prompt).match(/PARITY_[a-f0-9]+/)![0]);
              if (n > 1) expect(states.get(provider)).toBe(provider === "docker" ? "ready" : "stopped");
              states.set(provider, "ready");
              return Response.json({ promptId: `turn_${provider}_${n}` });
            }
            case "logs/read": {
              const n = turns.get(provider)!;
              return Response.json({
                events: [
                  { kind: "prompt", promptId: `turn_${provider}_${n}`, status: "finished" },
                  {
                    id: "answer",
                    kind: "message",
                    promptId: `turn_${provider}_${n}`,
                    text: n === 1 ? "SMOKE_OK" : memory.get(provider),
                    partial: false,
                    responseKind: "assistant",
                  },
                ],
              });
            }
            case "sandbox/list":
              return Response.json({ sandboxes: [{ ...body, id: id[provider], provider, status: "ready" }] });
            case "sandbox/status":
              if (
                mode === "post_status_refused" &&
                wire.some((call) => call.provider === provider) &&
                !statusRefused.has(provider)
              ) {
                statusRefused.add(provider);
                return Response.json(
                  { error: { code: "forbidden", message: "private_error_placeholder" } },
                  { status: 403 },
                );
              }
              return Response.json({ id: body.id, status: states.get(provider), settled: true, prompt: null });
            case "sandbox/stop":
              if (body.request_id) {
                cleanupStops.set(provider, (cleanupStops.get(provider) ?? 0) + 1);
                states.set(provider, "stopped");
                return Response.json({ id: body.id, status: "stopped" });
              }
              if (!body.org) {
                expect(body).toEqual({ id: id[provider] });
                if (mode === "dashboard_refused") {
                  wire.push({ provider, client: "dashboard" });
                  return Response.json(
                    { error: { code: "forbidden", message: "private_error_placeholder" } },
                    { status: 403 },
                  );
                }
                return Response.json(stop(provider, "dashboard"));
              }
              expect(body).toEqual({ org: org[provider], id: id[provider] });
              if (mode === "cli_unauthorized") {
                wire.push({ provider, client: "cli" });
                return Response.json(
                  { error: { code: "unauthorized", message: "private_error_placeholder" } },
                  { status: 401 },
                );
              }
              return Response.json(stop(provider, "cli"));
            case "sandbox/resume":
              expect(provider).toBe("docker");
              expect(states.get(provider)).toBe("stopped");
              states.set(provider, "ready");
              return Response.json({ id: body.id, status: "ready" });
            case sandboxDeletePath:
              deletes.set(provider, (deletes.get(provider) ?? 0) + 1);
              if (states.get(provider) === "stopping")
                return Response.json({ error: { code: "conflict" } }, { status: 409 });
              expect(states.get(provider)).toBe("stopped");
              states.set(provider, "deleted");
              return Response.json({ id: body.id, status: "deleted" });
            default:
              throw Error(`Unexpected ${route}`);
          }
        },
      },
      ["--feature", "client-stop"],
    );
    expect(passed).toBe(["valid", "unsupported", "resume_quota"].includes(mode));
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
      expect(report.features["client-stop"][provider].status).toBe(
        mode === "valid"
          ? "pass"
          : mode === "unsupported"
            ? "unsupported"
            : mode === "resume_quota"
              ? "not-run"
              : "fail",
      );
      if (mode === "ack_only") {
        expect(report.features.cleanup[provider]).toMatchObject({
          status: "fail",
          diagnostic: { code: "conflict", httpStatus: 409 },
        });
        expect(deletes.get(provider)).toBe(1);
      } else if (mode !== "unsupported") expect(report.features.cleanup[provider].status).toBe("pass");
      if (mode === "valid") {
        expect(wire.filter((call) => call.provider === provider).map((call) => call.client)).toEqual([
          "dashboard",
          "cli",
        ]);
        expect(turns.get(provider)).toBe(2);
        expect(cleanupStops.get(provider) ?? 0).toBe(0);
        for (const client of ["dashboard", "cli"])
          expect(report.features[`client-stop-${client}`][provider].status).toBe("pass");
      }
      if (["ack_only", "wrong_ack", "lost_ack", "late_stop", "dashboard_refused", "resume_quota"].includes(mode))
        expect(wire.some((call) => call.provider === provider && call.client === "cli")).toBe(false);
      if (["ack_only", "wrong_ack", "lost_ack", "late_stop", "post_status_refused"].includes(mode))
        expect(cleanupStops.get(provider) ?? 0).toBe(0);
      if (mode === "dashboard_refused") expect(cleanupStops.get(provider)).toBe(1);
      if (mode === "cli_unauthorized") {
        expect(report.features["client-stop-cli"][provider].diagnostic).toMatchObject({
          code: "unauthorized",
          httpStatus: 401,
        });
        expect(cleanupStops.get(provider)).toBe(1);
      }
    }
    expect(lines.join("\n")).not.toContain("private_error_placeholder");
  });
}

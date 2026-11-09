import { type HeaderSentinel, managedInspection as inspection, installHeaderSentinel } from "./managed-inspection.ts";
/** Opt-in managed proof using Armada's real API-only CLI client. Never prints transcripts or credentials. */

import { createArmadaApiClient } from "../../packages/cli/src/armada-api.ts";
import { productionAuthIo } from "../../packages/cli/src/auth-commands.ts";
import type { AgentEvent, Harness, McpConnectionDto, ToolCall } from "../../packages/core/src/index.ts";
import { parsePinnedMcpStdio } from "../../packages/core/src/index.ts";

type Check = {
  connectionId: string;
  tool: string;
  args: Record<string, unknown>;
  resultIncludes?: string;
  eventNames?: Partial<Record<Harness, string>>;
  serverName?: string;
};
type Manifest = { org: string; golden: string; connections: string[]; checks: Check[]; timeoutSeconds?: number };
type VmFacts = {
  configured: boolean;
  credentialArgvLeak: boolean;
  sentinelConfigured: boolean;
  nativeChildObserved: boolean;
  sentinelInNativeArgv: boolean;
  headers: Record<string, string>;
  stdio: Record<string, { processSeen: boolean; pinObserved: boolean; argvMatches: boolean }>;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const models = { claude: "claude-opus-5-5", codex: "gpt-6.1-sol" } as const;
function ensure(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
function replace(value: unknown, nonce: string): unknown {
  if (typeof value === "string") return value.replaceAll("$NONCE", nonce);
  if (Array.isArray(value)) return value.map((v) => replace(v, nonce));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v, nonce)]));
  return value;
}
function subset(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string") {
    try {
      actual = JSON.parse(actual);
    } catch {
      /* opaque tool input */
    }
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected))
    return (
      !!actual &&
      typeof actual === "object" &&
      Object.entries(expected).every(([k, v]) => subset((actual as Record<string, unknown>)[k], v))
    );
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--validate-program")) {
    const probe = { name: "argv_probe_syntax", url: "https://public.example/mcp", value: "harmless_syntax_sentinel" };
    for (const program of [inspection(["00000000-0000-4000-8000-000000000000"], probe), installHeaderSentinel(probe)]) {
      const js = program.split("\n").slice(1, -1).join("\n");
      const child = Bun.spawn(["node", "--check"], { stdin: new Blob([js]), stdout: "ignore", stderr: "ignore" });
      ensure((await child.exited) === 0, "inspection_program_syntax_invalid");
    }
    console.log(
      "Inspection program syntax validated; no VM, model, authentication or native conformance was exercised.",
    );
    return;
  }
  if (argv.includes("--help") || !argv.includes("--execute")) {
    console.log("Opt-in: bun scripts/mcp/managed-boat-probe.ts --execute --manifest <public-fixture-manifest.json>");
    console.log(
      "Uses existing Armada CLI authentication implicitly; reports only boolean proof facts, never logs/config/credentials.",
    );
    return;
  }
  const path = argv[argv.indexOf("--manifest") + 1];
  ensure(argv.includes("--manifest") && path, "manifest_required");
  const manifest = (await Bun.file(path).json()) as Manifest;
  ensure(
    uuid.test(manifest.org) && typeof manifest.golden === "string" && manifest.golden.length > 0,
    "invalid_manifest",
  );
  ensure(
    Array.isArray(manifest.connections) &&
      manifest.connections.length >= 2 &&
      manifest.connections.every((id) => uuid.test(id)),
    "invalid_connections",
  );
  ensure(
    Array.isArray(manifest.checks) &&
      manifest.checks.length > 0 &&
      manifest.checks.every(
        (c) =>
          manifest.connections.includes(c.connectionId) &&
          typeof c.tool === "string" &&
          c.args &&
          typeof c.args === "object",
      ),
    "invalid_tool_checks",
  );
  const timeout = (manifest.timeoutSeconds ?? 360) * 1000;
  ensure(timeout >= 30000 && timeout <= 600000, "invalid_timeout");
  const auth = productionAuthIo({ out: () => {}, err: () => {} });
  const api = await createArmadaApiClient({ env: auth.env, fetch: auth.fetch, session: auth.session });
  const post = <T>(path: string, body: Record<string, unknown>, ms = 30000) =>
    api.request<T>(`/api/v1/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: manifest.org, ...body }),
      signal: AbortSignal.timeout(ms),
    });
  const listed = await post<{ connections: McpConnectionDto[] }>("mcp/list", {});
  const selected = manifest.connections.map((id) => {
    const c = listed.connections.find((c) => c.id === id);
    ensure(c && c.status === "connected" && c.authType === "none", "use_only_connected_public_or_stdio_fixtures");
    return c;
  });
  ensure(
    selected.some((c) => c.transport !== "stdio"),
    "a_public_remote_fixture_is_required_to_certify_gateway_lease_rotation",
  );
  const stdio = selected.filter((c) => c.transport === "stdio");
  const launchers = stdio.map((c) => parsePinnedMcpStdio(c.command ?? "", c.args ?? []).command);
  ensure(launchers.includes("npx") && launchers.includes("uvx"), "both_pinned_launchers_required");
  ensure(
    selected.every((c) => manifest.checks.some((check) => check.connectionId === c.id)),
    "tool_check_required_for_each_selected_connection",
  );
  const publicFixture = selected.find((c) => c.transport === "http" && c.url);
  ensure(publicFixture?.url, "a_readonly_public_http_fixture_is_required_for_the_sentinel");
  const publicCheck = manifest.checks.find((c) => c.connectionId === publicFixture.id);
  ensure(publicCheck, "public_fixture_tool_check_required");
  const report: {
    harness: Harness;
    id: string;
    first: boolean;
    resume: boolean;
    argv: boolean;
    leaseRotated: boolean;
    cleanup: string;
  }[] = [];
  for (const harness of ["claude", "codex"] as const) {
    let id: string | undefined;
    const result = {
      harness,
      id: "",
      first: false,
      resume: false,
      argv: false,
      leaseRotated: false,
      cleanup: "not_started",
      nativeArgvObserved: false,
      sentinelInNativeArgv: false,
      credentialInNativeArgv: false,
    };
    const probe: HeaderSentinel = {
      name: `argv_probe_${crypto.randomUUID().replaceAll("-", "_")}`,
      url: publicFixture.url,
      value: `harmless_argv_sentinel_${crypto.randomUUID()}`,
    };
    const oldServer = `armada_${publicFixture.id.replaceAll("-", "_")}`;
    const checks: Check[] = [
      ...manifest.checks,
      {
        ...publicCheck,
        serverName: probe.name,
        eventNames: Object.fromEntries(
          Object.entries(publicCheck.eventNames ?? {}).map(([h, name]) => [h, name.replaceAll(oldServer, probe.name)]),
        ),
      },
    ];
    let cursor: string | null = null;
    const oldCalls = new Set<string>();
    const prompt = (nonce: string) =>
      "Managed MCP conformance. Use only the listed NATIVE MCP tools, once each; do not use shell, commands, files or HTTP tools, inspect authentication or print credentials. Never claim a call without performing it. " +
      JSON.stringify(
        checks.map((c) => ({
          server: c.serverName ?? `armada_${c.connectionId.replaceAll("-", "_")}`,
          tool: c.tool,
          arguments: replace(c.args, nonce),
        })),
      ) +
      " Then answer only PROBE_DONE.";
    const phase = async (promptId: string, nonce: string) => {
      ensure(id, "sandbox_missing");
      const deadline = Date.now() + timeout,
        seen = new Map<string, ToolCall>(),
        matched = new Set<number>();
      const aggregate: VmFacts = {
        configured: false,
        credentialArgvLeak: false,
        sentinelConfigured: false,
        nativeChildObserved: false,
        sentinelInNativeArgv: false,
        headers: {},
        stdio: {},
      };
      while (Date.now() < deadline) {
        const logs = await post<{ events: AgentEvent[]; cursor: string | null; hasMore: boolean }>("logs/read", {
          id,
          all: false,
          follow: false,
          ...(cursor ? { cursor } : {}),
        });
        cursor = logs.cursor ?? cursor;
        for (const event of logs.events)
          if (event.kind === "message")
            for (const call of event.tools) {
              if (oldCalls.has(call.id)) continue;
              seen.set(call.id, { ...seen.get(call.id), ...call });
            }
        checks.forEach((check, i) => {
          const server = check.serverName ?? `armada_${check.connectionId.replaceAll("-", "_")}`;
          const name = check.eventNames?.[harness] ?? `mcp__${server}__${check.tool}`;
          ensure(name.includes(server), "event_name_must_identify_selected_native_server");
          for (const call of seen.values())
            if (
              call.name === name &&
              call.result &&
              !call.result.isError &&
              subset(call.input, replace(check.args, nonce)) &&
              (!check.resultIncludes ||
                JSON.stringify(call.result.output).includes(check.resultIncludes.replaceAll("$NONCE", nonce)))
            )
              matched.add(i);
        });
        const inspected = await post<{
          exitCode: number | null;
          stdout: string;
          timedOut: boolean;
          truncated: boolean;
        }>("sandbox/exec", { id, command: inspection(manifest.connections, probe), timeout_seconds: 30 }, 60000);
        if (inspected.exitCode === 0 && !inspected.timedOut && !inspected.truncated) {
          const facts = JSON.parse(inspected.stdout) as VmFacts;
          aggregate.configured ||= facts.configured;
          aggregate.sentinelConfigured ||= facts.sentinelConfigured;
          aggregate.nativeChildObserved ||= facts.nativeChildObserved;
          aggregate.sentinelInNativeArgv ||= facts.sentinelInNativeArgv;
          result.nativeArgvObserved ||= facts.nativeChildObserved;
          result.sentinelInNativeArgv ||= facts.sentinelInNativeArgv;
          result.credentialInNativeArgv ||= facts.credentialArgvLeak;
          aggregate.credentialArgvLeak ||= facts.credentialArgvLeak;
          Object.assign(aggregate.headers, facts.headers);
          for (const [key, v] of Object.entries(facts.stdio)) {
            const old = aggregate.stdio[key];
            aggregate.stdio[key] = {
              processSeen: v.processSeen || !!old?.processSeen,
              pinObserved: v.pinObserved || !!old?.pinObserved,
              argvMatches: v.argvMatches || !!old?.argvMatches,
            };
          }
        }
        ensure(
          !aggregate.credentialArgvLeak && !aggregate.sentinelInNativeArgv,
          "native_argv_header_leak_output_withheld",
        );
        const argvOk = stdio.every((c) => {
          const s = aggregate.stdio[c.id];
          return s?.processSeen && s.pinObserved && s.argvMatches;
        });
        if (
          matched.size === checks.length &&
          aggregate.configured &&
          aggregate.sentinelConfigured &&
          aggregate.nativeChildObserved &&
          argvOk
        ) {
          for (const call of seen.values()) oldCalls.add(call.id);
          let settled = false;
          while (Date.now() < deadline && !settled) {
            const state = await post<{ settled: boolean; status: string; model: string; reasoningEffort: string }>(
              "sandbox/wait",
              { id, prompt_id: promptId, timeout_seconds: 30 },
              60000,
            );
            ensure(state.status !== "failed", "native_turn_failed_output_withheld");
            ensure(state.model === models[harness] && state.reasoningEffort === "medium", "model_or_effort_changed");
            settled = state.settled;
          }
          ensure(settled, "native_turn_did_not_settle");
          return aggregate;
        }
        if (!logs.hasMore) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw Error("native_tool_or_argv_proof_not_observed");
    };
    try {
      const firstNonce = crypto.randomUUID();
      const launch = await post<{
        sandbox: { id: string; visibility: string; model: string; reasoningEffort: string };
        promptId?: string;
      }>(
        "sandbox/launch",
        {
          golden: manifest.golden,
          provider: "boat",
          harness,
          model: models[harness],
          reasoningEffort: "medium",
          visibility: "private",
          connections: manifest.connections,
          ttlSeconds: 1800,
        },
        600000,
      );
      ensure(uuid.test(launch.sandbox.id), "invalid_launch_identity");
      id = launch.sandbox.id;
      result.id = id;
      ensure(
        launch.sandbox.visibility === "private" &&
          launch.sandbox.model === models[harness] &&
          launch.sandbox.reasoningEffort === "medium",
        "launch_contract_mismatch",
      );
      // Idle launch proves post-init prepare, then the first native prompt reads the
      // standard global configs, including this unmanaged harmless public fixture.
      const installed = await post<{ exitCode: number | null; stdout: string }>(
        "sandbox/exec",
        { id, command: installHeaderSentinel(probe), timeout_seconds: 30 },
        60000,
      );
      ensure(installed.exitCode === 0 && JSON.parse(installed.stdout).installed === true, "sentinel_install_failed");
      const firstSend = await post<{ promptId: string }>("sandbox/send", { id, prompt: prompt(firstNonce) }, 600000);
      const first = await phase(firstSend.promptId, firstNonce);
      result.first = true;
      await post("sandbox/stop", { id });
      const until = Date.now() + 180000;
      let stopped = false;
      while (Date.now() < until) {
        const state = await post<{ status: string; providerState: string }>("sandbox/status", { id });
        if (state.status === "stopped" && ["archived", "stopped"].includes(state.providerState)) {
          stopped = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      ensure(stopped, "physical_stop_not_observed");
      const nextNonce = crypto.randomUUID();
      const sent = await post<{ promptId: string }>("sandbox/send", { id, prompt: prompt(nextNonce) }, 600000);
      const resumed = await phase(sent.promptId, nextNonce);
      result.resume = true;
      result.argv = true;
      result.leaseRotated = selected
        .filter((c) => c.transport !== "stdio")
        .every(
          (c) => !!first.headers[c.id] && !!resumed.headers[c.id] && first.headers[c.id] !== resumed.headers[c.id],
        );
      ensure(result.leaseRotated, "gateway_lease_not_rotated_after_physical_resume");
    } finally {
      if (id)
        try {
          await post("sandbox/stop", { id });
          result.cleanup = "stopped_disk_retained_by_armada_policy";
        } catch {
          result.cleanup = "stop_failed_check_sandbox";
        }
      report.push(result);
      console.log(
        JSON.stringify({
          kind: "managed_mcp_probe",
          ...result,
          nativeResourcesPrompts: "not_certified_by_this_tool_only_probe",
          syntheticHeaderSentinelInNativeArgv: result.nativeArgvObserved ? result.sentinelInNativeArgv : null,
          actualCredentialInNativeArgv: result.nativeArgvObserved ? result.credentialInNativeArgv : null,
          nativeArgvCertification: result.first && result.resume ? "both_phases_observed" : "incomplete",
          firstPromptPath: "idle_prepare_then_first_native_send",
        }),
      );
    }
  }
  ensure(
    report.length === 2 &&
      report.every((r) => r.first && r.resume && r.argv && r.leaseRotated && r.cleanup.startsWith("stopped")),
    "managed_probe_incomplete",
  );
}
if (import.meta.main)
  await main().catch(() => {
    console.error(
      "Managed MCP proof failed; transcripts, raw errors and credentials are intentionally withheld. No native parity claim was made.",
    );
    process.exitCode = 1;
  });

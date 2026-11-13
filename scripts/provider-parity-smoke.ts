import { appendFile } from "node:fs/promises";
import { isHarness } from "../packages/core/src/harnesses.ts";
import type { LaunchProviderOption } from "../packages/core/src/index.ts";
import { STAGING_ORIGIN } from "./smoke-sandbox-cleanup.ts";

type Provider = "boat" | "modal" | "docker";
type Cell = { status: "pass" | "fail" | "unsupported"; reason: string | null };
const steps = {
  launch: "launch",
  send: "followupPrompts",
  status: "status",
  logs: "logs",
  stop: "stop",
  resume: "resume",
  delete: "delete",
} as const;
interface Case {
  provider: Provider;
  org: string;
  harness: string;
  model: string;
  modelAccountId: string;
  golden?: string;
  hostId?: string;
  image?: string;
}
interface Io {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  out: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  recordSandbox?: (org: string, id: string, key: string) => Promise<void>;
}

/** Additive staging observation: never replaces the existing deploy-gating smoke. */
export async function providerParitySmoke(env: NodeJS.ProcessEnv, io: Io): Promise<boolean> {
  let cases: Case[];
  try {
    if (env.ARMADA_URL !== STAGING_ORIGIN || !env.ARMADA_TOKEN || env.ARMADA_SMOKE !== "create_real_compute")
      throw new Error();
    cases = JSON.parse(env.ARMADA_SMOKE_CASES ?? "");
    if (!Array.isArray(cases) || cases.length !== 3 || new Set(cases.map((c) => c.provider)).size !== 3)
      throw new Error();
    for (const c of cases) {
      if (
        !["boat", "modal", "docker"].includes(c.provider) ||
        !isHarness(c.harness) ||
        [c.org, c.model, c.modelAccountId].some((v) => typeof v !== "string" || !v.trim()) ||
        (c.provider === "docker"
          ? typeof c.hostId !== "string" || !c.hostId.trim() || typeof c.image !== "string" || !c.image.trim()
          : typeof c.golden !== "string" || !c.golden.trim())
      )
        throw new Error();
    }
  } catch {
    io.out(JSON.stringify({ step: "configure", pass: false, code: "invalid_configuration" }));
    return false;
  }
  const deadline = io.now() + 35 * 60_000;
  async function request<T>(path: string, body: object): Promise<T> {
    // Fixed diagnostics only: response bodies may contain credentials or user content.
    const response = await io.fetch(`${STAGING_ORIGIN}/api/v1/${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(600_000),
      headers: { authorization: `Bearer ${env.ARMADA_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return response.json() as Promise<T>;
  }
  async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean) {
    for (let i = 0; i < 120 && io.now() < deadline; i++) {
      const value = await read();
      if (done(value)) return value;
      await io.sleep(1000);
    }
    throw new Error("poll_limit_exceeded");
  }
  const report: Record<string, Partial<Record<Provider, Cell>>> = {};
  const record = (step: string, provider: Provider, status: Cell["status"], reason: string | null = null) => {
    report[step] ??= {};
    report[step][provider] = { status, reason };
  };
  for (const c of cases) {
    let option: LaunchProviderOption | undefined;
    let id: string | undefined;
    let stopped = false;
    let blocked: string | undefined;
    const api = <T>(path: string, body: object = {}) => request<T>(path, { org: c.org, ...body });
    async function runTurn() {
      if (!id) throw new Error("launch_not_available");
      const turn = await api<{ promptId: string }>("sandbox/send", {
        id,
        prompt: "Reply with exactly SMOKE_OK and do not use tools.",
        ...(c.provider === "docker" ? { request_id: crypto.randomUUID() } : {}),
      });
      if (!option?.capabilities.logs) throw new Error("logs_not_available");
      if (!turn.promptId) throw new Error("invalid_turn_receipt");
      // Logs are a normal route supported by all three; no preview journal or host ACK shortcut.
      let cursor: string | undefined;
      let finished = false;
      let answered = false;
      await poll(
        () =>
          api<{ cursor?: string; events: { kind: string; promptId?: string; status?: string; text?: string }[] }>(
            "logs/read",
            { id, ...(cursor ? { cursor } : {}) },
          ),
        (page) => {
          if (
            page.events.some(
              (e) =>
                e.promptId === turn.promptId &&
                e.kind === "prompt" &&
                ["failed", "interrupted"].includes(e.status ?? ""),
            )
          )
            throw new Error("turn_failed");
          cursor = page.cursor;
          finished ||= page.events.some(
            (e) => e.promptId === turn.promptId && e.kind === "prompt" && e.status === "finished",
          );
          answered ||= page.events.some(
            (e) => e.promptId === turn.promptId && e.kind === "message" && e.text?.includes("SMOKE_OK"),
          );
          return finished && answered;
        },
      );
    }
    try {
      const options = await api<{ providers: LaunchProviderOption[] }>("launch/options");
      option = options.providers.find((p) => p.id === c.provider);
      if (!option) throw new Error("missing_provider_options");
      if (!option.harnesses.includes(c.harness as never)) throw new Error("harness_not_advertised");
      if (c.provider === "docker" && option.capabilities.launch) {
        const hosts = await api<{ hosts: { id: string; state: string }[] }>("docker/hosts/list");
        if (!hosts.hosts.some((h) => h.id === c.hostId && h.state === "online")) {
          blocked = "host_offline";
          record("host_offline", c.provider, "fail", blocked);
          io.out(JSON.stringify({ provider: c.provider, step: "host_offline", pass: false, code: blocked }));
        }
      }
    } catch {
      blocked = "discovery_failed";
    }
    for (const [step, capability] of Object.entries(steps) as [
      keyof typeof steps,
      (typeof steps)[keyof typeof steps],
    ][]) {
      if (option?.capabilities[capability] === false) {
        const reason = option.unsupportedReasons[capability];
        record(step, c.provider, reason ? "unsupported" : "fail", reason ?? "missing_unsupported_reason");
        continue;
      }
      // Cleanup operations still run after an earlier probe failed.
      if (blocked && !((step === "stop" || step === "delete") && id)) {
        record(step, c.provider, "fail", blocked);
        continue;
      }
      try {
        if (step === "launch") {
          const result = await api<{ sandbox: { id: string; provider: string } }>("sandbox/launch", {
            provider: c.provider,
            harness: c.harness,
            model: c.model,
            credentialId: c.modelAccountId,
            visibility: "private",
            ttlSeconds: 1800,
            ...(c.provider === "docker"
              ? { hostId: c.hostId, image: c.image, requestId: crypto.randomUUID() }
              : { golden: c.golden, connections: [] }),
          });
          if (typeof result.sandbox?.id === "string") {
            id = result.sandbox.id;
            await io.recordSandbox?.(c.org, id, `parity:${crypto.randomUUID()}`);
          }
          if (!id || result.sandbox.provider !== c.provider) throw new Error("invalid_launch_receipt");
        } else {
          if (!id) throw new Error("launch_not_available");
          if (step === "send") {
            await runTurn();
          } else if (step === "status") {
            const result = await api<{ id: string; provider?: string; status: string }>("sandbox/status", { id });
            if (
              result.id !== id ||
              result.status !== "ready" ||
              (c.provider === "docker" && result.provider !== "docker")
            )
              throw new Error("invalid_status_receipt");
          } else if (step === "logs") {
            const result = await api<{ events: unknown[] }>("logs/read", { id });
            if (!Array.isArray(result.events)) throw new Error("invalid_logs_receipt");
          } else {
            const expected = step === "resume" ? "ready" : step === "stop" ? "stopped" : "deleted";
            // Never delete a resumed allocation before confirming a second stop.
            if (step === "delete" && !stopped) {
              await api("sandbox/stop", { id, request_id: crypto.randomUUID() });
              await poll(
                () => api<{ status: string }>("sandbox/status", { id }),
                (value) => value.status === "stopped",
              );
              stopped = true;
            }
            if (step === "resume") stopped = false;
            const receipt =
              step === "resume" && c.provider !== "docker"
                ? (await runTurn(), { status: "ready" })
                : await api<{ status: string }>(`sandbox/${step}`, { id, request_id: crypto.randomUUID() });
            if (step !== "delete")
              await poll(
                () => api<{ status: string }>("sandbox/status", { id }),
                (value) => value.status === expected,
              );
            else if (receipt.status !== "deleted") throw new Error("delete_unconfirmed");
            stopped = step !== "resume";
          }
        }
        record(step, c.provider, "pass");
      } catch {
        record(step, c.provider, "fail", "operation_failed");
        blocked = `${step}_failed`;
      }
    }
    // A successful resume must be stopped before deletion; delete may already have handled it.
    if (id && !stopped) {
      try {
        await api("sandbox/stop", { id, request_id: crypto.randomUUID() });
      } catch {
        record("cleanup", c.provider, "fail", "cleanup_unconfirmed");
      }
    }
  }
  io.out(JSON.stringify({ step: "provider_parity", version: 1, features: report }));
  const escapeCell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ");
  const table = [
    "## Provider lifecycle parity",
    "",
    "| Feature | Boat | Modal | Docker |",
    "| --- | --- | --- | --- |",
    ...Object.entries(report).map(
      ([feature, providers]) =>
        `| ${feature} | ${(["boat", "modal", "docker"] as const)
          .map((p) => {
            const cell = providers[p];
            return cell ? escapeCell(`${cell.status}${cell.reason ? `: ${cell.reason}` : ""}`) : "—";
          })
          .join(" | ")} |`,
    ),
  ].join("\n");
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${table}\n`);
  else io.out(table);
  return Object.values(report).every((providers) => Object.values(providers).every((cell) => cell.status !== "fail"));
}

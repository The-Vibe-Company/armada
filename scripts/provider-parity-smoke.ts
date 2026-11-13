import { appendFile } from "node:fs/promises";
import { isHarness } from "../packages/core/src/harnesses.ts";
import type { LaunchProviderOption } from "../packages/core/src/index.ts";
import { STAGING_ORIGIN } from "./smoke-sandbox-cleanup.ts";

type Provider = "boat" | "modal" | "docker";
type Cell = { status: "pass" | "fail" | "unsupported" | "not-run"; reason: string | null };
const steps = {
  launch: "launch",
  send: "followupPrompts",
  status: "status",
  logs: "logs",
  exec: "exec",
  stop: "stop",
  resume: "resume",
  delete: "delete",
} as const;
// Stable feature IDs are also the --feature vocabulary. Unimplemented probes are
// explicit not-run debt, never inferred support or a successful proof.
const features = [
  ...Object.keys(steps),
  "launch-default",
  "launch-snapshot",
  "steer",
  "interrupt",
  "resume-recall",
  "github",
  "repository-refresh",
  "readable-variables",
  "application-secrets",
  "mcp",
  "skills",
  "templates",
  "routines",
  "usage",
  "exact-cost",
  "subscription-account",
  "codex",
  "claude-code",
  "opencode",
  "scoped-child-access",
];
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
export async function providerParitySmoke(env: NodeJS.ProcessEnv, io: Io, args: string[] = []): Promise<boolean> {
  let cases: Case[];
  let only: Provider | undefined;
  let feature: string | undefined;
  try {
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i];
      const value = args[i + 1];
      if (flag === "--only" && !only && ["boat", "modal", "docker"].includes(value ?? "")) only = value as Provider;
      else if (flag === "--feature" && !feature && features.includes(value ?? "")) feature = value;
      else throw new Error();
    }
  } catch {
    io.out(JSON.stringify({ step: "configure", pass: false, code: "invalid_parity_filter" }));
    return false;
  }
  try {
    if (env.ARMADA_URL !== STAGING_ORIGIN || !env.ARMADA_TOKEN || env.ARMADA_SMOKE !== "create_real_compute")
      throw new Error();
    cases = JSON.parse(env.ARMADA_SMOKE_CASES ?? "");
    if (!Array.isArray(cases) || cases.length === 0 || new Set(cases.map((c) => c.provider)).size !== cases.length)
      throw new Error();
    if (only) cases = cases.filter((c) => c.provider === only);
    else if (cases.length !== 3) throw new Error();
    if (cases.length === 0) throw new Error();
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
  for (const name of features)
    for (const provider of ["boat", "modal", "docker"] as const)
      record(
        name,
        provider,
        "not-run",
        only && provider !== only
          ? "provider_filtered"
          : feature && name !== feature
            ? "feature_filtered"
            : "probe_not_implemented",
      );
  let starts = 0;
  for (const c of cases) {
    // A not-yet-implemented row must not allocate compute merely to print debt.
    if (feature && !Object.hasOwn(steps, feature) && feature !== "resume-recall") continue;
    let option: LaunchProviderOption | undefined;
    let id: string | undefined;
    let stopped = false;
    const memory = `PARITY_${crypto.randomUUID().replaceAll("-", "")}`;
    let blocked: string | undefined;
    const api = <T>(path: string, body: object = {}) => request<T>(path, { org: c.org, ...body });
    async function runTurn(recall = false) {
      if (!id) throw new Error("launch_not_available");
      const turn = await api<{ promptId: string }>("sandbox/send", {
        id,
        prompt: recall
          ? "What PARITY_ token did I ask you to remember? Reply with only that token, without tools."
          : `Remember this token for later: ${memory}. Reply with exactly SMOKE_OK and do not use tools.`,
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
            (e) =>
              e.promptId === turn.promptId && e.kind === "message" && e.text?.includes(recall ? memory : "SMOKE_OK"),
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
      // Prerequisites may execute but remain visibly not-run(filtered) in the table.
      const needed =
        !feature ||
        step === feature ||
        step === "launch" ||
        step === "stop" ||
        step === "delete" ||
        ((feature === "resume" || feature === "resume-recall") && ["send", "resume"].includes(step));
      if (!needed) continue;
      const selected = !feature || step === feature;
      if (option?.capabilities[capability] === false) {
        const reason = option.unsupportedReasons[capability];
        record(
          selected ? step : `prerequisite:${step}`,
          c.provider,
          reason ? "unsupported" : "fail",
          reason ?? "missing_unsupported_reason",
        );
        continue;
      }
      // Cleanup operations still run after an earlier probe failed.
      if (blocked && !((step === "stop" || step === "delete") && id)) {
        record(selected ? step : `prerequisite:${step}`, c.provider, "fail", blocked);
        continue;
      }
      try {
        if (step === "launch") {
          starts++;
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
          } else if (step === "exec") {
            const result = await api<{ exitCode: number | null; timedOut: boolean; stdout: string }>("sandbox/exec", {
              id,
              command: "printf PARITY_EXEC_OK",
              cwd: "/tmp",
              timeout_seconds: 30,
            });
            if (result.exitCode !== 0 || result.timedOut !== false || result.stdout !== "PARITY_EXEC_OK")
              throw new Error("invalid_exec_receipt");
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
                ? (await runTurn(true), { status: "ready" })
                : await api<{ status: string }>(`sandbox/${step}`, { id, request_id: crypto.randomUUID() });
            if (step !== "delete")
              await poll(
                () => api<{ status: string }>("sandbox/status", { id }),
                (value) => value.status === expected,
              );
            else if (receipt.status !== "deleted") throw new Error("delete_unconfirmed");
            stopped = step !== "resume";
            if (step === "resume" && (!feature || feature === "resume-recall")) {
              if (c.provider === "docker") await runTurn(true);
              record("resume-recall", c.provider, "pass");
            }
          }
        }
        record(selected ? step : `prerequisite:${step}`, c.provider, "pass");
      } catch {
        record(selected ? step : `prerequisite:${step}`, c.provider, "fail", "operation_failed");
        blocked = `${step}_failed`;
        if (step === "resume" && (!feature || feature === "resume-recall"))
          record("resume-recall", c.provider, "fail", "resume_or_recall_failed");
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
  io.out(JSON.stringify({ step: "provider_parity", version: 2, starts, features: report }));
  const escapeCell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ");
  const table = [
    "## Provider feature parity",
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
    "",
    ...(["boat", "modal", "docker"] as const).map((provider) => {
      const cells = Object.values(report).map((row) => row[provider]);
      return `${provider}: ${cells.filter((cell) => cell?.status === "unsupported").length} unsupported; ${cells.filter((cell) => cell?.status === "not-run").length} not-run`;
    }),
    `Launch attempts: ${starts} (maximum one per selected provider; resume may allocate provider compute).`,
  ].join("\n");
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${table}\n`);
  else io.out(table);
  return Object.values(report).every((providers) => Object.values(providers).every((cell) => cell.status !== "fail"));
}

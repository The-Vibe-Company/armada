import { appendFile } from "node:fs/promises";
import { isHarness } from "../packages/core/src/harnesses.ts";
import type { LaunchProviderOption } from "../packages/core/src/index.ts";
import type { SandboxUsage } from "../packages/core/src/sandbox-usage.ts";
import { redactForLog } from "../packages/mcp-server/src/log.ts";
import { STAGING_ORIGIN } from "./smoke-sandbox-cleanup.ts";
import { BOAT_STAGING_NOTICE, smokeReceiptProvider, stagingSmokeCases } from "./staging-smoke-policy.ts";

type Provider = "boat" | "modal" | "docker";
type Diagnostic = { code: string; httpStatus?: number; message: string; quota?: boolean };
type Cell = { status: "pass" | "fail" | "unsupported" | "not-run"; reason: string | null; diagnostic?: Diagnostic };

class ParityError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.code);
  }
}
const localCodes = new Set([
  "poll_limit_exceeded",
  "launch_not_available",
  "logs_not_available",
  "invalid_turn_receipt",
  "turn_failed",
  "invalid_usage_receipt",
  "invalid_cost_receipt",
  "missing_provider_options",
  "harness_not_advertised",
  "invalid_launch_receipt",
  "invalid_exec_receipt",
  "invalid_status_receipt",
  "invalid_logs_receipt",
  "delete_unconfirmed",
]);
function diagnostic(error: unknown): Diagnostic {
  if (error instanceof ParityError) return error.diagnostic;
  const code = error instanceof Error && localCodes.has(error.message) ? error.message : "transport_or_receipt_failed";
  return { code, message: code.replaceAll("_", " ") };
}
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
  // #1562: explicit debt rows; manual stop/resume is not idle-pause/wake proof.
  "idle-pause",
  "wake-on-send",
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
  provider: Exclude<Provider, "boat">;
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
  recordSandbox?: (org: string, id: string, key: string, provider?: "modal" | "docker") => Promise<void>;
}

/** Additive staging observation: never replaces the existing deploy-gating smoke. */
export async function providerParitySmoke(env: NodeJS.ProcessEnv, io: Io, args: string[] = []): Promise<boolean> {
  io.out(BOAT_STAGING_NOTICE);
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
  if (only === "boat") {
    io.out(
      JSON.stringify({
        step: "provider_parity",
        version: 2,
        starts: 0,
        features: Object.fromEntries(
          features.map((name) => [name, { boat: { status: "not-run", reason: "owner_decision_2026_11_13" } }]),
        ),
      }),
    );
    return false;
  }
  try {
    if (env.ARMADA_URL !== STAGING_ORIGIN || !env.ARMADA_TOKEN || env.ARMADA_SMOKE !== "create_real_compute")
      throw new Error();
    cases = stagingSmokeCases(JSON.parse(env.ARMADA_SMOKE_CASES ?? "")) as Case[];
    if (!Array.isArray(cases) || cases.length === 0 || new Set(cases.map((c) => c.provider)).size !== cases.length)
      throw new Error();
    if (only) cases = cases.filter((c) => c.provider === only);
    else if (cases.length !== 2) throw new Error();
    if (cases.length === 0) throw new Error();
    for (const c of cases) {
      if (
        !["modal", "docker"].includes(c.provider) ||
        !isHarness(c.harness) ||
        [c.org, c.model, c.modelAccountId].some((v) => typeof v !== "string" || !v.trim()) ||
        (c.provider === "docker"
          ? typeof c.hostId !== "string" || !c.hostId.trim()
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
    // Never serialize the response envelope, details, or arbitrary caught errors.
    const response = await io.fetch(`${STAGING_ORIGIN}/api/v1/${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(600_000),
      headers: { authorization: `Bearer ${env.ARMADA_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: unknown; message?: unknown };
      } | null;
      const code =
        typeof body?.error?.code === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(body.error.code)
          ? body.error.code
          : "api_failed";
      // The API error.message is the server's public diagnostic, not an upstream
      // response body. Bound it, remove controls and redact common credential forms.
      const message =
        typeof body?.error?.message === "string"
          ? redactForLog(body.error.message)
              .replaceAll(env.ARMADA_TOKEN!, "[redacted]")
              .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
              .replace(/(token|password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
              .replace(/https?:\/\/[^\s]+/gi, "[url redacted]")
              .replace(/\p{Cc}/gu, " ")
              .slice(0, 400)
          : "No safe server message returned.";
      throw new ParityError({
        code,
        httpStatus: response.status,
        message,
        quota: response.status === 429 || ["quota_exceeded", "rate_limited", "start_limit_exceeded"].includes(code),
      });
    }
    const result = (await response.json()) as { sandbox?: { provider?: unknown } } | null;
    if (path === "sandbox/launch" && !["modal", "docker"].includes(String(smokeReceiptProvider(result))))
      throw new ParityError({ code: "invalid_launch_receipt", message: "Unexpected staging provider" });
    return result as T;
  }
  async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, attempts = 120) {
    for (let i = 0; i < attempts && io.now() < deadline; i++) {
      const value = await read();
      if (done(value)) return value;
      await io.sleep(1000);
    }
    throw new Error("poll_limit_exceeded");
  }
  const report: Record<string, Partial<Record<Provider, Cell>>> = {};
  const record = (
    step: string,
    provider: Provider,
    status: Cell["status"],
    reason: string | null = null,
    detail?: Diagnostic,
  ) => {
    report[step] ??= { boat: { status: "not-run", reason: "owner_decision_2026_11_13" } };
    report[step][provider] = { status, reason, ...(detail ? { diagnostic: detail } : {}) };
  };
  for (const name of features)
    for (const provider of ["boat", "modal", "docker"] as const)
      record(
        name,
        provider,
        "not-run",
        provider === "boat"
          ? "owner_decision_2026_11_13"
          : only && provider !== only
            ? "provider_filtered"
            : feature && name !== feature
              ? "feature_filtered"
              : "probe_not_implemented",
      );
  let starts = 0;
  for (const c of cases) {
    // A not-yet-implemented row must not allocate compute merely to print debt.
    if (feature && !Object.hasOwn(steps, feature) && !["resume-recall", "usage", "exact-cost"].includes(feature))
      continue;
    let option: LaunchProviderOption | undefined;
    let id: string | undefined;
    let stopped = false;
    let deleted = false;
    let stopRequested = false;
    const memory = `PARITY_${crypto.randomUUID().replaceAll("-", "")}`;
    let afterResume = false;
    const measuredPrompts = new Set<string>();
    const retainedPrices = new Map<string, string>();
    let blocked: string | undefined;
    let blockedDiagnostic: Diagnostic | undefined;
    const api = <T>(path: string, body: object = {}) => request<T>(path, { org: c.org, ...body });
    async function checkUsage(promptId: string) {
      if (feature && !["usage", "exact-cost"].includes(feature)) return;
      const observe = (name: string, status: Cell["status"], reason: string | null = null, detail?: Diagnostic) => {
        record(`${name}-${afterResume ? "after" : "before"}-resume`, c.provider, status, reason, detail);
        // A before-resume observation alone is not proof of resume retention.
        if (status === "pass" && !afterResume && report[name]?.[c.provider]?.status !== "fail")
          record(name, c.provider, "not-run", "resume_not_observed");
        if (status !== "pass" || afterResume) {
          if (report[name]?.[c.provider]?.status !== "fail") {
            if (status === "pass" && report[`${name}-before-resume`]?.[c.provider]?.status !== "pass")
              record(name, c.provider, "not-run", "baseline_not_observed");
            else record(name, c.provider, status, reason, detail);
          }
        }
      };
      measuredPrompts.add(promptId);
      let usage: SandboxUsage | undefined;
      try {
        await poll(
          async () => {
            const page = await api<{ usage?: SandboxUsage }>("sandbox/detail", { id });
            usage = page.usage;
            return usage;
          },
          (value) => {
            return (
              !!value &&
              [...measuredPrompts].every((prompt) =>
                value.turns?.some(
                  (turn) =>
                    turn.promptId === prompt &&
                    Number.isSafeInteger(turn.inputTokens) &&
                    (turn.inputTokens ?? -1) >= 0 &&
                    Number.isSafeInteger(turn.outputTokens) &&
                    (turn.outputTokens ?? -1) >= 0,
                ),
              )
            );
          },
        );
        if (!usage || usage.turnCount !== new Set(usage.turns.map((turn) => turn.promptId)).size)
          throw new Error("invalid_usage_receipt");
        if (report.usage?.[c.provider]?.status !== "fail") observe("usage", "pass");
      } catch (error) {
        const detail = diagnostic(error);
        observe("usage", detail.quota ? "not-run" : "fail", detail.code, detail);
        if (!feature || feature === "exact-cost")
          observe("exact-cost", detail.quota ? "not-run" : "fail", "usage_unavailable", detail);
        return;
      }
      if (feature === "usage") return;
      try {
        // Compare fixed-point integers, never binary floating point or current
        // catalog prices. These are the service's persisted USD quotes.
        const units = (value: unknown) => {
          if (typeof value !== "string" || !/^\d{1,30}(?:\.\d{1,18})?$/.test(value))
            throw new Error("invalid_cost_receipt");
          const [whole, fraction = ""] = value.split(".");
          return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
        };
        if (usage.cost?.currency !== "USD" || usage.cost.unknown !== null || usage.cost.unpricedTurns !== 0)
          throw new Error("invalid_cost_receipt");
        const current = new Map<string, string>();
        let sum = 0n;
        for (const turn of usage.turns) {
          const key = JSON.stringify([turn.promptId, turn.model]);
          if (current.has(key) || !turn.pricing || turn.pricing.unknown !== null)
            throw new Error("invalid_cost_receipt");
          sum += units(turn.pricing.usd);
          current.set(key, JSON.stringify(turn.pricing));
        }
        if (sum !== units(usage.cost.usd) || [...retainedPrices].some(([key, value]) => current.get(key) !== value))
          throw new Error("invalid_cost_receipt");
        for (const [key, value] of current) retainedPrices.set(key, value);
        if (report["exact-cost"]?.[c.provider]?.status !== "fail") observe("exact-cost", "pass");
      } catch (error) {
        const detail = diagnostic(error);
        observe("exact-cost", "fail", detail.code, detail);
      }
    }
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
      await checkUsage(turn.promptId);
    }
    async function deleteKnown() {
      if (!id) throw new Error("launch_not_available");
      if (!stopped) {
        let stopError: unknown;
        if (!stopRequested) {
          stopRequested = true;
          try {
            await api("sandbox/stop", { id, request_id: crypto.randomUUID() });
          } catch (error) {
            stopError = error;
          }
        }
        try {
          const terminal = await poll(
            () => api<{ id: string; status: string }>("sandbox/status", { id }),
            (value) => value.id === id && ["stopped", "failed", "deleted"].includes(value.status),
          );
          if (terminal.status === "deleted") {
            deleted = true;
            stopped = true;
            return terminal;
          }
        } catch (error) {
          throw stopError ?? error;
        }
        stopped = true;
      }
      const requestId = crypto.randomUUID();
      const invoke = () => api<{ id?: string; status: string }>("sandbox/delete", { id, request_id: requestId });
      let receipt: { id?: string; status: string };
      // Modal termination/recovery-image cleanup can be pending, and a
      // failed attempt holds an activity lease. Reconcile the same delete;
      // never replay stop or launch a replacement allocation.
      let lastDeleteError: unknown;
      try {
        receipt = await poll(
          async () => {
            try {
              return await invoke();
            } catch (error) {
              lastDeleteError = error;
              const detail = diagnostic(error);
              if (["conflict", "unavailable", "sandbox_busy"].includes(detail.code)) return { status: "pending" };
              throw error;
            }
          },
          (value) => value.status === "deleted",
          240,
        );
      } catch (error) {
        throw lastDeleteError ?? error;
      }
      if (receipt.status !== "deleted" || receipt.id !== id) throw new Error("delete_unconfirmed");
      deleted = true;
      return receipt;
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
    } catch (error) {
      blocked = "discovery_failed";
      blockedDiagnostic = diagnostic(error);
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
        (["resume", "resume-recall", "usage", "exact-cost"].includes(feature ?? "") &&
          ["send", "resume"].includes(step));
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
        record(
          selected ? step : `prerequisite:${step}`,
          c.provider,
          blockedDiagnostic?.quota ? "not-run" : "fail",
          blockedDiagnostic?.quota ? "quota" : blocked,
          blockedDiagnostic,
        );
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
              ? { hostId: c.hostId, requestId: crypto.randomUUID() }
              : { golden: c.golden, connections: [] }),
          });
          if (typeof result.sandbox?.id === "string") {
            id = result.sandbox.id;
            await io.recordSandbox?.(c.org, id, `post-deploy-smoke:${crypto.randomUUID()}`, c.provider);
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
              ...(c.provider === "docker" ? { request_id: crypto.randomUUID() } : {}),
              cwd: "/tmp",
              timeout_seconds: 30,
            });
            if (result.exitCode !== 0 || result.timedOut !== false || result.stdout !== "PARITY_EXEC_OK")
              throw new Error("invalid_exec_receipt");
          } else if (step === "status") {
            const result = await api<{ id: string; provider?: string; status: string }>("sandbox/status", { id });
            // The shared schema makes provider optional. Docker retains running
            // after the turn finishes; prompt settlement is separate machine state.
            if (result.id !== id || !["ready", "running"].includes(result.status))
              throw new Error("invalid_status_receipt");
          } else if (step === "logs") {
            const result = await api<{ events: unknown[] }>("logs/read", { id });
            if (!Array.isArray(result.events)) throw new Error("invalid_logs_receipt");
          } else {
            const expected = step === "resume" ? "ready" : step === "stop" ? "stopped" : "deleted";
            if (step === "resume") {
              afterResume = true;
              stopped = false;
              stopRequested = false;
            }
            if (step === "stop") stopRequested = true;
            const requestId = crypto.randomUUID();
            const invoke = () => api<{ status: string }>(`sandbox/${step}`, { id, request_id: requestId });
            let receipt: { status: string };
            if (step === "resume" && c.provider !== "docker") {
              await runTurn(true);
              receipt = { status: "ready" };
            } else if (step === "delete") {
              receipt = await deleteKnown();
            } else receipt = await invoke();
            if (step !== "delete")
              await poll(
                () => api<{ status: string }>("sandbox/status", { id }),
                (value) => value.status === expected,
              );
            else if (receipt.status !== "deleted") throw new Error("delete_unconfirmed");
            stopped = step !== "resume";
            if (step === "resume" && (!feature || ["resume-recall", "usage", "exact-cost"].includes(feature))) {
              if (c.provider === "docker") await runTurn(true);
              record("resume-recall", c.provider, "pass");
            }
          }
        }
        record(selected ? step : `prerequisite:${step}`, c.provider, "pass");
      } catch (error) {
        const detail = diagnostic(error);
        record(
          selected ? step : `prerequisite:${step}`,
          c.provider,
          detail.quota ? "not-run" : "fail",
          detail.quota ? "quota" : detail.code,
          detail,
        );
        blocked = `${step}_failed`;
        blockedDiagnostic = detail;
        if (step === "resume" && (!feature || ["resume-recall", "usage", "exact-cost"].includes(feature)))
          record(
            "resume-recall",
            c.provider,
            detail.quota ? "not-run" : "fail",
            detail.quota ? "quota" : detail.code,
            detail,
          );
      }
    }
    // Probe failures never replace cleanup. A failed journal write or lost
    // resume acknowledgement still leaves a known allocation to reconcile.
    if (id) {
      try {
        if (!deleted) await deleteKnown();
        record("cleanup", c.provider, "pass");
      } catch (error) {
        const detail = diagnostic(error);
        // Known resources remain unconfirmed even when the refusal is quota.
        record("cleanup", c.provider, "fail", "cleanup_unconfirmed", detail);
      }
      io.out(JSON.stringify({ step: "parity_cleanup", provider: c.provider, id, deleted }));
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
            return cell
              ? escapeCell(
                  `${cell.status}${cell.diagnostic ? `: ${cell.reason}; HTTP ${cell.diagnostic.httpStatus ?? "n/a"}; ${cell.diagnostic.code}; ${cell.diagnostic.message}` : cell.reason ? `: ${cell.reason}` : ""}`,
                )
              : "—";
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

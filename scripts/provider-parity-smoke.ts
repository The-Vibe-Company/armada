import { appendFile } from "node:fs/promises";
import { isHarness } from "../packages/core/src/harnesses.ts";
import type { LaunchProviderOption } from "../packages/core/src/index.ts";
import type { SandboxUsage } from "../packages/core/src/sandbox-usage.ts";
import { redactForLog } from "../packages/mcp-server/src/log.ts";
import { STAGING_ORIGIN } from "./smoke-sandbox-cleanup.ts";
import { BOAT_STAGING_NOTICE, smokeReceiptProvider, stagingSmokeCases } from "./staging-smoke-policy.ts";

type Provider = "boat" | "modal" | "docker";
type Diagnostic = {
  code: string;
  httpStatus?: number;
  message: string;
  quota?: boolean;
  elapsedMs?: number;
  polls?: number;
  serverElapsedMs?: number | null;
};
// Match the server wait tool's maximum observation window (tools.ts MAX_WAIT_SECONDS).
// This is a bound, not an assertion about any provider's expected latency.
const OBSERVATION_MS = 600_000;
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
  github: "github",
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
const accountMatrix = {
  "codex-openai": "codex",
  "codex-subscription": "codex",
  "codex-azure": "codex",
  "claude-anthropic": "claude",
  "claude-subscription": "claude",
  "claude-gateway": "claude",
  "opencode-deepseek": "opencode",
  "opencode-openai": "opencode",
  "opencode-anthropic": "opencode",
  "opencode-custom": "opencode",
  "opencode-azure": "opencode",
} as const;

interface Case {
  githubRepository?: string;
  account?: keyof typeof accountMatrix;
  notRunReason?: "account has no declared model";
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
  accountProbe?: boolean;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  out: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  recordSandbox?: (org: string, id: string, key: string, provider?: "modal" | "docker") => Promise<void>;
}

/** Observational parity; production Boat verification requires explicit coordinator opt-in. */
export async function providerParitySmoke(env: NodeJS.ProcessEnv, io: Io, args: string[] = []): Promise<boolean> {
  const productionBoat = args.includes("--production-boat");
  const notice = productionBoat ? "boat: production verification (coordinator opt-in)" : BOAT_STAGING_NOTICE;
  io.out(notice);
  const out = io.out;
  io = {
    ...io,
    out: (line) => {
      if (line !== notice) out(line);
    },
  };
  if (args.includes("--accounts") && !productionBoat) return accountsParity(env, io, args);
  let cases: Case[];
  let only: Provider | undefined;
  let feature: string | undefined;
  let origin = STAGING_ORIGIN;
  try {
    let productionFlagSeen = false;
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--production-boat" && !productionFlagSeen) {
        productionFlagSeen = true;
        continue;
      }
      const value = args[++i];
      if (flag === "--only" && !only && ["boat", "modal", "docker"].includes(value ?? "")) only = value as Provider;
      else if (flag === "--feature" && !feature && features.includes(value ?? "")) feature = value;
      else throw new Error();
    }
    if (productionBoat && only !== "boat") throw new Error();
  } catch {
    io.out(JSON.stringify({ step: "configure", pass: false, code: "invalid_parity_filter" }));
    return false;
  }
  if (only === "boat" && !productionBoat) {
    io.out(
      JSON.stringify({
        step: "provider_parity",
        version: 2,
        starts: 0,
        features: Object.fromEntries(
          features.map((name) => [name, { boat: { status: "not-run", reason: "not_part_of_release_gate" } }]),
        ),
      }),
    );
    return false;
  }
  try {
    if (!env.ARMADA_TOKEN || env.ARMADA_SMOKE !== "create_real_compute") throw new Error();
    if (productionBoat) {
      if (env.CI || env.GITHUB_ACTIONS || env.ARMADA_SMOKE_JOURNAL || !env.ARMADA_URL) throw new Error();
      const url = new URL(env.ARMADA_URL);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.origin === STAGING_ORIGIN ||
        ![url.origin, `${url.origin}/`].includes(env.ARMADA_URL)
      )
        throw new Error();
      origin = url.origin;
      const raw: unknown = JSON.parse(env.ARMADA_SMOKE_CASES ?? "");
      if (!Array.isArray(raw)) throw new Error();
      cases = raw.filter((c) => c && typeof c === "object" && c.provider === "boat");
      if (cases.length !== 1) throw new Error();
    } else {
      if (env.ARMADA_URL !== STAGING_ORIGIN) throw new Error();
      cases = stagingSmokeCases(JSON.parse(env.ARMADA_SMOKE_CASES ?? "")) as Case[];
      if (!Array.isArray(cases) || cases.length === 0 || new Set(cases.map((c) => c.provider)).size !== cases.length)
        throw new Error();
      if (only) cases = cases.filter((c) => c.provider === only);
      else if (cases.length !== 2) throw new Error();
      if (cases.length === 0) throw new Error();
    }
    for (const c of cases) {
      if (
        !(productionBoat ? c.provider === "boat" : ["modal", "docker"].includes(c.provider)) ||
        !isHarness(c.harness) ||
        (c.githubRepository !== undefined &&
          (typeof c.githubRepository !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(c.githubRepository))) ||
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
  let requestDeadline: number | undefined;
  async function request<T>(path: string, body: object): Promise<T> {
    // Never serialize the response envelope, details, or arbitrary caught errors.
    const remaining = (requestDeadline ?? Number.POSITIVE_INFINITY) - io.now();
    if (remaining <= 0) throw new Error("poll_limit_exceeded");
    const response = await io.fetch(`${origin}/api/v1/${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.min(600_000, remaining))),
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
    if (path === "sandbox/launch") {
      const expected = (body as { provider?: unknown }).provider;
      if (smokeReceiptProvider(result) !== expected)
        throw new ParityError({ code: "invalid_launch_receipt", message: "Unexpected launch provider" });
    }
    return result as T;
  }
  async function poll<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    attempts = 600,
    until = Math.min(deadline, io.now() + OBSERVATION_MS),
    observed?: (elapsedMs: number, polls: number) => void,
  ) {
    const started = io.now();
    const previousRequestDeadline = requestDeadline;
    requestDeadline = until;
    let polls = 0;
    try {
      while (polls < attempts && io.now() < until) {
        polls++;
        const value = await read();
        if (io.now() > until) throw new Error("poll_limit_exceeded");
        if (done(value)) return value;
        await io.sleep(Math.min(1000, Math.max(0, until - io.now())));
      }
      throw new Error("poll_limit_exceeded");
    } catch (error) {
      throw new ParityError({ ...diagnostic(error), elapsedMs: io.now() - started, polls });
    } finally {
      requestDeadline = previousRequestDeadline;
      observed?.(io.now() - started, polls);
    }
  }
  const report: Record<string, Partial<Record<Provider, Cell>>> = {};
  const record = (
    step: string,
    provider: Provider,
    status: Cell["status"],
    reason: string | null = null,
    detail?: Diagnostic,
  ) => {
    report[step] ??= productionBoat ? {} : { boat: { status: "not-run", reason: "not_part_of_release_gate" } };
    report[step][provider] = { status, reason, ...(detail ? { diagnostic: detail } : {}) };
  };
  for (const name of features)
    for (const provider of ["boat", "modal", "docker"] as const)
      record(
        name,
        provider,
        "not-run",
        provider === "boat" && !productionBoat
          ? "not_part_of_release_gate"
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
    if (feature === "github" && !c.githubRepository) {
      record("github", c.provider, "not-run", "github_repository_not_configured");
      continue;
    }
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
      if (io.accountProbe)
        io.out(
          JSON.stringify({
            step: "account_usage",
            provider: c.provider,
            afterResume,
            turns: usage.turns.map((turn) => ({
              promptId: turn.promptId,
              model: turn.model,
              inputTokens: turn.inputTokens,
              outputTokens: turn.outputTokens,
            })),
            cost: usage.cost,
          }),
        );
      try {
        // Compare fixed-point integers, never binary floating point or current
        // catalog prices. These are the service's persisted USD quotes.
        const units = (value: unknown) => {
          if (typeof value !== "string" || !/^\d{1,30}(?:\.\d{1,18})?$/.test(value))
            throw new Error("invalid_cost_receipt");
          const [whole, fraction = ""] = value.split(".");
          return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
        };
        const classification = usage.cost?.classification;
        if (!["priced", "included_in_subscription", "unknown"].includes(classification ?? ""))
          throw new Error("invalid_cost_receipt");
        if (
          classification === "included_in_subscription" &&
          (usage.cost?.basis !== "api_equivalent" ||
            usage.turns.some(
              (turn) =>
                turn.pricing?.billing !== "subscription" ||
                typeof turn.pricing.credentialId !== "string" ||
                !turn.pricing.credentialId,
            ))
        )
          throw new Error("invalid_cost_receipt");
        if (usage.cost?.unknown && usage.cost.usd === null) {
          const current = new Map<string, string>();
          const unpriced = new Set<string>();
          const seen = new Set<string>();
          for (const turn of usage.turns) {
            const key = JSON.stringify([turn.promptId, turn.model]);
            if (seen.has(key)) throw new Error("invalid_cost_receipt");
            seen.add(key);
            if (!turn.pricing) throw new Error("invalid_cost_receipt");
            if (turn.pricing.unknown !== null) {
              if (turn.pricing.usd !== null || turn.pricing.unknown !== "price")
                throw new Error("invalid_cost_receipt");
              unpriced.add(turn.promptId);
            } else units(turn.pricing.usd);
            current.set(key, JSON.stringify(turn.pricing));
          }
          if (
            usage.cost.currency !== "USD" ||
            usage.cost.unknown !== "price" ||
            classification === "priced" ||
            unpriced.size === 0 ||
            usage.cost.unpricedTurns !== unpriced.size ||
            [...retainedPrices].some(([key, value]) => current.get(key) !== value)
          )
            throw new Error("invalid_cost_receipt");
          for (const [key, value] of current) retainedPrices.set(key, value);
          observe(
            "exact-cost",
            "pass",
            classification === "included_in_subscription"
              ? "included in subscription"
              : `unknown: ${usage.cost.unknown}`,
          );
          return;
        }
        if (
          classification === "unknown" ||
          usage.cost?.currency !== "USD" ||
          usage.cost.unknown !== null ||
          usage.cost.unpricedTurns !== 0
        )
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
        if (report["exact-cost"]?.[c.provider]?.status !== "fail")
          observe(
            "exact-cost",
            "pass",
            classification === "included_in_subscription"
              ? "included in subscription"
              : `${usage.cost.basis ?? "unknown basis"}: USD ${usage.cost.usd}`,
          );
      } catch (error) {
        const detail = diagnostic(error);
        observe("exact-cost", "fail", detail.code, detail);
      }
    }
    async function runTurn(recall = false) {
      const turnStarted = io.now();
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
      let serverStarted: number | undefined;
      let serverFinished: number | undefined;
      let elapsedMs = 0;
      let polls = 0;
      try {
        await poll(
          () =>
            api<{
              cursor?: string;
              events: { at?: number; kind: string; promptId?: string; status?: string; text?: string }[];
            }>("logs/read", { id, ...(cursor ? { cursor } : {}) }),
          (page) => {
            for (const event of page.events) {
              if (event.promptId !== turn.promptId || event.kind !== "prompt" || !Number.isFinite(event.at)) continue;
              if (["queued", "running"].includes(event.status ?? ""))
                serverStarted = Math.min(serverStarted ?? event.at!, event.at!);
              if (["finished", "failed", "interrupted"].includes(event.status ?? ""))
                serverFinished = Math.max(serverFinished ?? event.at!, event.at!);
            }
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
          600,
          Math.min(deadline, turnStarted + OBSERVATION_MS),
          (_elapsed, count) => {
            elapsedMs = io.now() - turnStarted;
            polls = count;
          },
        );
      } catch (error) {
        throw new ParityError({
          ...diagnostic(error),
          elapsedMs: io.now() - turnStarted,
          serverElapsedMs:
            serverStarted !== undefined && serverFinished !== undefined && serverFinished >= serverStarted
              ? serverFinished - serverStarted
              : null,
        });
      } finally {
        io.out(
          JSON.stringify({
            step: "parity_turn",
            provider: c.provider,
            afterResume,
            elapsedMs,
            polls,
            serverElapsedMs:
              serverStarted !== undefined && serverFinished !== undefined && serverFinished >= serverStarted
                ? serverFinished - serverStarted
                : null,
          }),
        );
      }
      await checkUsage(turn.promptId);
    }
    async function deleteKnown() {
      if (!id) throw new Error("launch_not_available");
      const cleanupDeadline = io.now() + OBSERVATION_MS;
      {
        let stopError: unknown;
        if (!stopped && !stopRequested) {
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
            600,
            cleanupDeadline,
          );
          if (terminal.status === "deleted") {
            deleted = true;
            stopped = true;
            return terminal;
          }
        } catch (error) {
          if (stopError) {
            const observation = diagnostic(error);
            throw new ParityError({
              ...diagnostic(stopError),
              elapsedMs: observation.elapsedMs ?? 0,
              polls: observation.polls ?? 0,
            });
          }
          throw error;
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
              if (["conflict", "unavailable", "sandbox_busy", "sandbox_not_ready"].includes(detail.code))
                return { status: "pending" };
              throw error;
            }
          },
          (value) => value.status === "deleted",
          600,
          cleanupDeadline,
        );
      } catch (error) {
        if (lastDeleteError)
          throw new ParityError({
            ...diagnostic(lastDeleteError),
            elapsedMs: diagnostic(error).elapsedMs ?? 0,
            polls: diagnostic(error).polls ?? 0,
          });
        throw error;
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
      if (
        c.githubRepository &&
        (!feature || feature === "github") &&
        option.capabilities.github !== false &&
        c.provider !== "docker"
      ) {
        // Runtime GitHub grants are bound to the frozen golden repositories.
        // Do not allocate a sandbox whose grant cannot authorize this fixture.
        const configured = await api<{ provider: string; repositories: { url: string }[] }>("golden/size-policy", {
          golden: c.golden,
          provider: c.provider,
        });
        if (
          configured.provider !== c.provider ||
          !configured.repositories.some(
            (repository) =>
              /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/
                .exec(repository.url)?.[1]
                ?.toLowerCase() === c.githubRepository!.toLowerCase(),
          )
        )
          throw new ParityError({
            code: "github_repository_not_in_golden",
            message: "GitHub fixture must be included in the selected provider golden.",
          });
      }
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
        (feature === "github" && step === "send") ||
        (["resume", "resume-recall", "usage", "exact-cost"].includes(feature ?? "") &&
          ["send", "resume"].includes(step));
      if (!needed) continue;
      const selected = !feature || step === feature;
      if (step === "github" && !c.githubRepository) {
        record("github", c.provider, "not-run", "github_repository_not_configured");
        continue;
      }
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
      const operationStarted = io.now();
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
              ? {
                  hostId: c.hostId,
                  requestId: crypto.randomUUID(),
                  ...(c.githubRepository && (!feature || feature === "github")
                    ? {
                        repos: [
                          {
                            url: `https://github.com/${c.githubRepository}.git`,
                            branch: "main",
                            dir: "armada-parity-github",
                          },
                        ],
                      }
                    : {}),
                }
              : { golden: c.golden, connections: [] }),
          });
          if (typeof result.sandbox?.id !== "string" || !result.sandbox.id || result.sandbox.provider !== c.provider)
            throw new Error("invalid_launch_receipt");
          id = result.sandbox.id;
          if (c.provider !== "boat")
            await io.recordSandbox?.(c.org, id, `post-deploy-smoke:${crypto.randomUUID()}`, c.provider);
        } else {
          if (!id) throw new Error("launch_not_available");
          if (step === "send") {
            await runTurn();
            if (io.accountProbe) await runTurn(true);
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
          } else if (step === "github") {
            // Only an operator-selected populated private test repository.
            // Clone and receive-pack dry-run exercise the delivered Git credentials;
            // no branch or commit is ever written to GitHub.
            const repository = c.githubRepository!;
            const branch = `armada-parity-${crypto.randomUUID()}`;
            const command = [
              "set -eu",
              "umask 077",
              "export GIT_TERMINAL_PROMPT=0",
              "scratch=$(mktemp -d /tmp/armada-parity-github.XXXXXX)",
              `trap 'rm -rf -- "$scratch"' EXIT`,
              `test "$(gh api 'repos/${repository}' --jq '.private and .permissions.push' 2>/dev/null)" = true || { printf PARITY_GITHUB_AUTH_FAILED; exit 11; }`,
              `git -c core.hooksPath=/dev/null -c init.templateDir= clone --quiet --depth 1 --no-checkout 'https://github.com/${repository}.git' "$scratch/repo" >/dev/null 2>&1 || { printf PARITY_GITHUB_CLONE_FAILED; exit 12; }`,
              `git -c core.hooksPath=/dev/null -C "$scratch/repo" push --dry-run origin 'HEAD:refs/heads/${branch}' >/dev/null 2>&1 || { printf PARITY_GITHUB_PUSH_FAILED; exit 13; }`,
              "printf PARITY_GITHUB_OK",
            ].join("\n");
            const result = await api<{ exitCode: number | null; timedOut: boolean; stdout?: string }>("sandbox/exec", {
              id,
              command,
              cwd: "/tmp",
              timeout_seconds: 90,
              ...(c.provider === "docker" ? { request_id: crypto.randomUUID() } : {}),
            });
            if (result.exitCode !== 0 || result.timedOut !== false || result.stdout !== "PARITY_GITHUB_OK") {
              const code =
                result.stdout === "PARITY_GITHUB_AUTH_FAILED"
                  ? "github_auth_failed"
                  : result.stdout === "PARITY_GITHUB_CLONE_FAILED"
                    ? "github_clone_failed"
                    : result.stdout === "PARITY_GITHUB_PUSH_FAILED"
                      ? "github_push_failed"
                      : "github_probe_failed";
              throw new ParityError({ code, message: code.replaceAll("_", " ") });
            }
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
        const caught = diagnostic(error);
        const detail = {
          ...caught,
          elapsedMs: caught.elapsedMs ?? io.now() - operationStarted,
          polls: caught.polls ?? 0,
        };
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
    // These probes already share the provider's lifecycle sandbox. If a
    // prerequisite prevents observation, report that cause, not implementation debt.
    for (const name of ["resume-recall", "usage", "exact-cost"]) {
      if (feature && feature !== name) continue;
      const cell = report[name]?.[c.provider];
      if (cell?.status !== "not-run" || !["probe_not_implemented", "resume_not_observed"].includes(cell.reason ?? ""))
        continue;
      const prerequisite = ["launch", "send", "stop", "resume"]
        .map((step) => ({ step, cell: report[feature ? `prerequisite:${step}` : step]?.[c.provider] }))
        .find(({ cell }) => cell && cell.status !== "pass");
      record(
        name,
        c.provider,
        "not-run",
        prerequisite
          ? `${prerequisite.step}: ${prerequisite.cell?.reason ?? prerequisite.cell?.status}`
          : "resume_not_observed",
        prerequisite?.cell?.diagnostic,
      );
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
                  `${cell.status}${cell.diagnostic ? `: ${cell.reason}; HTTP ${cell.diagnostic.httpStatus ?? "n/a"}; ${cell.diagnostic.code}; ${cell.diagnostic.message}; elapsedMs=${cell.diagnostic.elapsedMs ?? "n/a"}; polls=${cell.diagnostic.polls ?? 0}; serverElapsedMs=${cell.diagnostic.serverElapsedMs ?? "unknown"}` : cell.reason ? `: ${cell.reason}` : ""}`,
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

/** Same lifecycle probe, isolated report per account; no second provider implementation. */
async function accountsParity(env: NodeJS.ProcessEnv, io: Io, args: string[]): Promise<boolean> {
  let cases: Case[];
  let providers: Array<"modal" | "docker"> = ["modal", "docker"];
  let field = "arguments";
  const invalid = (path: string, reason: string): never => {
    field = path;
    throw new Error(reason);
  };
  const nonempty = (value: unknown, path: string) => {
    if (typeof value !== "string" || !value.trim()) invalid(path, "must be a non-empty string");
  };
  try {
    if (
      args.length === 3 &&
      args[0] === "--accounts" &&
      args[1] === "--only" &&
      (args[2] === "modal" || args[2] === "docker")
    )
      providers = [args[2]];
    else if (args.length !== 1 || args[0] !== "--accounts")
      invalid("arguments", "expected --accounts [--only modal|docker]");
    if (env.ARMADA_URL !== STAGING_ORIGIN) invalid("ARMADA_URL", `must equal ${STAGING_ORIGIN}`);
    nonempty(env.ARMADA_TOKEN, "ARMADA_TOKEN");
    if (env.ARMADA_SMOKE !== "create_real_compute") invalid("ARMADA_SMOKE", "must equal create_real_compute");
    field = "ARMADA_SMOKE_CASES";
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.ARMADA_SMOKE_CASES ?? "[]");
    } catch {
      invalid(field, "must be a JSON array");
    }
    if (!Array.isArray(parsed)) invalid(field, "must be a JSON array");
    cases = [];
    const seen = new Set<string>();
    for (const [index, row] of (parsed as unknown[]).entries()) {
      const path = `ARMADA_SMOKE_CASES[${index}]`;
      if (!row || typeof row !== "object" || Array.isArray(row)) invalid(path, "must be an object");
      const c = row as Case;
      // Keep original indexes in diagnostics, while ignoring unused Boat fields.
      if (c.provider === "boat") continue;
      if (c.provider !== "modal" && c.provider !== "docker")
        invalid(`${path}.provider`, "must be modal or docker (Boat is skipped)");
      if (typeof c.account !== "string" || !Object.hasOwn(accountMatrix, c.account))
        invalid(`${path}.account`, `must be one of: ${Object.keys(accountMatrix).join(", ")}`);
      if (accountMatrix[c.account!] !== c.harness) invalid(`${path}.harness`, "must match the selected account label");
      if (c.notRunReason !== undefined && c.notRunReason !== "account has no declared model")
        invalid(`${path}.notRunReason`, "must equal account has no declared model when supplied");
      if (!c.notRunReason) nonempty(c.model, `${path}.model`);
      for (const name of ["org", "modelAccountId", c.provider === "docker" ? "hostId" : "golden"] as const)
        nonempty(c[name], `${path}.${name}`);
      const key = `${c.provider}:${c.account}`;
      if (seen.has(key)) invalid(`${path}.account`, "duplicate provider/account pair");
      seen.add(key);
      cases.push(c);
    }
  } catch (error) {
    // Only controlled diagnostics: never echo supplied JSON, token or account values.
    io.out(
      JSON.stringify({
        step: "configure",
        pass: false,
        code: "invalid_accounts_configuration",
        field,
        message: error instanceof Error ? error.message : "invalid configuration",
      }),
    );
    return false;
  }
  const accounts: Record<string, Partial<Record<Provider, unknown>>> = {};
  let passed = true;
  const table = ["## Accounts parity", "", "| Account | Provider | Result |", "| --- | --- | --- |"];
  for (const account of Object.keys(accountMatrix) as Array<keyof typeof accountMatrix>) {
    accounts[account] = {};
    for (const provider of providers) {
      const c = cases.find((c) => c.account === account && c.provider === provider);
      const reason = c?.notRunReason ?? "no account on staging";
      let result: object = { status: "not-run", reason };
      let status = `not-run: ${reason}`;
      if (c && !c.notRunReason) {
        let receipt: Record<string, Partial<Record<Provider, Cell>>> | undefined;
        const ok = await providerParitySmoke(
          { ...env, ARMADA_SMOKE_CASES: JSON.stringify([c]), GITHUB_STEP_SUMMARY: undefined },
          {
            ...io,
            accountProbe: true,
            out: (line) => {
              try {
                const value = JSON.parse(line);
                if (value.step === "provider_parity") receipt = value.features;
                io.out(JSON.stringify({ ...value, account }));
              } catch {
                /* The human-readable lifecycle table is replaced by the account table. */
              }
            },
          },
          ["--only", provider],
        );
        passed &&= ok;
        const required = ["launch", "send", "stop", "resume", "resume-recall", "usage", "exact-cost", "cleanup"];
        const complete = required.every((name) => receipt?.[name]?.[provider]?.status === "pass");
        const outcome = !ok ? "fail" : complete ? "pass" : "not-run";
        result = { status: outcome, features: receipt };
        status = `${outcome} (see per-feature diagnostics and cost classification)`;
      }
      accounts[account]![provider] = result;
      table.push(`| ${account} | ${provider} | ${status} |`);
    }
  }
  io.out(JSON.stringify({ step: "accounts_parity", version: 1, accounts }));
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${table.join("\n")}\n`);
  else io.out(table.join("\n"));
  return passed;
}

import { appendFile } from "node:fs/promises";
import { isHarness } from "../packages/core/src/harnesses.ts";
import type { LaunchProviderOption } from "../packages/core/src/index.ts";
import type { SandboxUsage } from "../packages/core/src/sandbox-usage.ts";
import { TEMPLATE_REFUSAL_HELP } from "../packages/core/src/templates.ts";
import { redactForLog } from "../packages/mcp-server/src/log.ts";
import { ClientSendError, probeClientSend } from "./provider-parity-client-send.ts";
import { probeClientStop } from "./provider-parity-client-stop.ts";
import { isMcpProbeBinding, type McpProbeBinding, McpProbeError, prepareMcpProbe } from "./provider-parity-mcp.ts";
import {
  isReadableVariableBinding,
  prepareReadableProbe,
  ReadableProbeError,
  type ReadableVariableBinding,
} from "./provider-parity-readable-variable.ts";
import { probeRoutine, RoutineProbeError } from "./provider-parity-routine.ts";
import {
  isSecretProbeBinding,
  prepareSecretProbe,
  type SecretProbeBinding,
  SecretProbeError,
} from "./provider-parity-secret.ts";
import { isSkillsProbeBinding, prepareSkillsProbe, type SkillsProbeBinding } from "./provider-parity-skills.ts";
import deadlines from "./smoke-deadlines.json";
import { observeSmokeLaunch } from "./smoke-launch.ts";
import { STAGING_ORIGIN } from "./smoke-sandbox-cleanup.ts";
import { BOAT_STAGING_NOTICE, smokeReceiptProvider, stagingSmokeCases } from "./staging-smoke-policy.ts";

type Provider = "boat" | "modal" | "docker";
type Diagnostic = {
  code: string;
  httpStatus?: number;
  message: string;
  quota?: boolean;
  notRun?: boolean;
  elapsedMs?: number;
  polls?: number;
  serverElapsedMs?: number | null;
  requestKey?: string;
  requestId?: string;
};
// Match the server wait tool's maximum observation window (tools.ts MAX_WAIT_SECONDS).
// This is a bound, not an assertion about any provider's expected latency.
const OBSERVATION_MS = 600_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const launchTimeouts = deadlines as Record<string, number>;
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
  "invalid_idle_receipt",

  "invalid_snapshot_source",
  "invalid_template_receipt",
  "invalid_control_receipt",
  "invalid_skills_binding",
  "invalid_skills_receipt",
  "skills_content_mismatch",
  "control_turn_not_active",
  "invalid_status_receipt",
  "invalid_logs_receipt",
  "delete_unconfirmed",
]);
function diagnostic(error: unknown): Diagnostic {
  if (error instanceof ParityError) return error.diagnostic;
  if (error instanceof ClientSendError)
    return {
      code: error.code,
      message: `The ${error.client} client ${error.action} failed (${error.code}).`,
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
      quota:
        error.httpStatus === 429 || ["quota_exceeded", "rate_limited", "start_limit_exceeded"].includes(error.code),
      ...(error.code === "client_send_conversation_unavailable" ? { notRun: true } : {}),
    };
  if (error instanceof McpProbeError) return { code: error.code, message: error.code.replaceAll("_", " ") };
  if (error instanceof SecretProbeError)
    return {
      code: error.code,
      message: error.code.replaceAll("_", " "),
      ...(error.code === "secret_canary_expiry_unsupported" ? { notRun: true } : {}),
    };
  if (error instanceof ReadableProbeError)
    return {
      code: error.code,
      message: error.code.replaceAll("_", " "),
      ...(error.code === "readable_canary_required" ? { notRun: true } : {}),
    };
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
  "idle-pause": "status",
  "wake-on-send": "followupPrompts",
  stop: "stop",
  resume: "resume",
  steer: "steer",
  interrupt: "interrupt",
  delete: "delete",
} as const;
// Stable feature IDs are also the --feature vocabulary. Unimplemented probes are
// explicit not-run debt, never inferred support or a successful proof.
const harnessFeatures = { codex: "codex", "claude-code": "claude", opencode: "opencode" } as const;
const features = [
  ...Object.keys(steps),
  "client-send",
  "client-stop",
  "launch-default",
  "launch-snapshot",
  "resume-recall",
  "repository-refresh",
  "readable-variables",
  "application-secrets",
  "mcp",
  "mcp-resume",
  "skills",
  "skills-resume",
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
  "claude-morph": "claude",
  "codex-morph": "codex",
  "opencode-morph": "opencode",
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
  clientStop?: boolean;
  clientSend?: boolean;
  mcpResume?: boolean;
  skillsResume?: boolean;
  subscriptionAccount?: boolean;
  mcp?: McpProbeBinding;
  applicationSecret?: SecretProbeBinding;
  skill?: SkillsProbeBinding;
  readableVariable?: ReadableVariableBinding;
  routine?: boolean;
  template?: { id: string; revision: number };
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
  snapshotId?: string;
}
interface Io {
  deadline?: number;
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
        (c.snapshotId !== undefined &&
          (c.provider !== "docker" ||
            typeof c.snapshotId !== "string" ||
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(c.snapshotId))) ||
        (c.subscriptionAccount !== undefined && typeof c.subscriptionAccount !== "boolean") ||
        (c.clientStop !== undefined && typeof c.clientStop !== "boolean") ||
        (c.clientSend !== undefined && typeof c.clientSend !== "boolean") ||
        (c.mcpResume !== undefined && typeof c.mcpResume !== "boolean") ||
        (c.mcp !== undefined && !isMcpProbeBinding(c.mcp)) ||
        (c.applicationSecret !== undefined && !isSecretProbeBinding(c.applicationSecret)) ||
        (c.skillsResume !== undefined && typeof c.skillsResume !== "boolean") ||
        (c.skill !== undefined && !isSkillsProbeBinding(c.skill)) ||
        (c.routine !== undefined && typeof c.routine !== "boolean") ||
        (c.readableVariable !== undefined && !isReadableVariableBinding(c.readableVariable)) ||
        (c.template !== undefined &&
          (typeof c.template !== "object" ||
            c.template === null ||
            typeof c.template.id !== "string" ||
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(c.template.id) ||
            !Number.isSafeInteger(c.template.revision) ||
            c.template.revision < 1)) ||
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
  const deadline = Math.min(io.deadline ?? Number.POSITIVE_INFINITY, io.now() + 35 * 60_000);
  if (!only && !feature && !productionBoat) {
    // Each provider gets its own request/poll deadlines and cleanup state. Never
    // parallelize the steps within a provider's lifecycle or authority fences.
    const combined: Record<string, Partial<Record<Provider, Cell>>> = {};
    let starts = 0;
    const outcomes = await Promise.all(
      cases.map(async (c) => {
        let observed = false;
        const ok = await providerParitySmoke(
          { ...env, GITHUB_STEP_SUMMARY: undefined },
          {
            ...io,
            deadline,
            out: (line) => {
              let value: { step?: string; starts?: number; features?: typeof combined };
              try {
                value = JSON.parse(line);
              } catch {
                return;
              }
              if (value.step !== "provider_parity") {
                io.out(line);
                return;
              }
              observed = true;
              starts += value.starts ?? 0;
              for (const [name, providers] of Object.entries(value.features ?? {})) {
                combined[name] ??= { boat: { status: "not-run", reason: "not_part_of_release_gate" } };
                // A child marks its sibling filtered; only carry the selected column.
                const cell = providers[c.provider];
                if (cell) combined[name][c.provider] = cell;
              }
            },
          },
          [...args, "--only", c.provider],
        );
        if (!observed) {
          combined.provider_evidence ??= {};
          combined.provider_evidence[c.provider] = { status: "fail", reason: "provider_report_missing" };
        }
        return ok && observed;
      }),
    );
    const reported = await publishParityReport(env, io, starts, combined);
    return outcomes.every(Boolean) && reported;
  }

  let requestDeadline: number | undefined;
  async function request<T>(path: string, body: object, timeoutMs = 600_000): Promise<T> {
    // Never serialize the response envelope, details, or arbitrary caught errors.
    const remaining = (requestDeadline ?? Number.POSITIVE_INFINITY) - io.now();
    if (remaining <= 0) throw new Error("poll_limit_exceeded");
    const response = await io.fetch(`${origin}/api/v1/${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remaining))),
      headers: { authorization: `Bearer ${env.ARMADA_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const modalLaunch = path === "sandbox/launch" && (body as { provider?: unknown }).provider === "modal";
    const keyedDockerLaunch =
      path === "sandbox/launch" && (body as { provider?: unknown }).provider === "docker" && "externalRef" in body;
    const requestId = modalLaunch || keyedDockerLaunch ? response.headers.get("x-request-id") : null;
    const correlation = requestId && UUID.test(requestId) ? { requestId } : {};
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
        ...correlation,
        message,
        quota: response.status === 429 || ["quota_exceeded", "rate_limited", "start_limit_exceeded"].includes(code),
      });
    }
    const result = (await response.json().catch((error: unknown) => {
      if (!modalLaunch && !keyedDockerLaunch) throw error;
      throw new ParityError({
        code: "launch_response_unreadable",
        httpStatus: response.status,
        message: "Launch response could not be read.",
        ...correlation,
      });
    })) as { provider?: unknown; sandbox?: { id?: unknown; provider?: unknown } } | null;
    if (path === "sandbox/launch") {
      const expected = (body as { provider?: unknown }).provider;
      if (
        (keyedDockerLaunch && result?.sandbox?.id !== (body as { requestId?: unknown }).requestId) ||
        (modalLaunch &&
          (typeof result?.sandbox?.id !== "string" ||
            !UUID.test(result.sandbox.id) ||
            (result.sandbox.provider === undefined && (result.provider === undefined || result.provider === "modal"))))
      )
        throw new ParityError({
          code: "launch_response_unreadable",
          httpStatus: response.status,
          message: "Launch response had no usable sandbox receipt.",
          ...correlation,
        });
      if (smokeReceiptProvider(result) !== expected || (modalLaunch && result?.sandbox?.provider !== "modal"))
        throw new ParityError({
          code: "invalid_launch_receipt",
          message: "Unexpected launch provider",
          ...correlation,
        });
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
    if (
      feature === "subscription-account" ||
      feature === "skills-resume" ||
      feature === "mcp-resume" ||
      feature === "client-send" ||
      feature === "client-stop"
    )
      until = Math.min(until, requestDeadline ?? Number.POSITIVE_INFINITY);
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
  let idleDelay: number | undefined;
  if (!feature || ["idle-pause", "wake-on-send"].includes(feature)) {
    try {
      const response = await io.fetch(`${origin}/healthz`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${env.ARMADA_TOKEN}` },
      });
      const health = (await response.json()) as { idlePauseDelayMs?: number };
      if (response.ok && Number.isSafeInteger(health.idlePauseDelayMs) && (health.idlePauseDelayMs ?? 0) > 0)
        idleDelay = health.idlePauseDelayMs;
    } catch {
      /* Missing diagnostics are explicit not-run, never a guessed delay. */
    }
  }
  let starts = 0;
  for (const c of cases) {
    const idleFeature = feature && ["idle-pause", "wake-on-send"].includes(feature);
    const idleUnavailable =
      idleDelay === undefined
        ? "idle_delay_not_advertised"
        : io.now() + idleDelay + 180_000 >= deadline
          ? "idle_observation_exceeds_run_budget"
          : undefined;
    if (idleUnavailable) {
      for (const name of ["idle-pause", "wake-on-send"])
        if (!feature || feature === name) record(name, c.provider, "not-run", idleUnavailable);
      if (idleFeature) continue;
    }
    if (!feature && c.clientSend !== true)
      record("client-send", c.provider, "not-run", "client_send_probe_not_enabled");
    if (feature === "client-send" || (!feature && c.clientSend === true)) {
      for (const client of ["dashboard", "cli"])
        record(`client-send-${client}`, c.provider, "not-run", "client_not_observed");
    }
    if (!feature && c.clientStop !== true)
      record("client-stop", c.provider, "not-run", "client_stop_probe_not_enabled");
    if (feature === "client-stop" || (!feature && c.clientStop === true)) {
      for (const client of ["dashboard", "cli"])
        record(`client-stop-${client}`, c.provider, "not-run", "client_not_observed");
    }
    const harnessFeature = c.harness === "claude" ? "claude-code" : c.harness;
    const requestedHarness = feature && Object.hasOwn(harnessFeatures, feature);
    for (const name of Object.keys(harnessFeatures))
      if ((!feature || feature === name) && name !== harnessFeature)
        record(name, c.provider, "not-run", "harness_account_not_configured");
    if (requestedHarness && feature !== harnessFeature) continue;
    if ((!feature || feature === "launch-snapshot") && c.provider === "docker") {
      if (!feature || !c.snapshotId) {
        record(
          "launch-snapshot",
          c.provider,
          "not-run",
          c.snapshotId ? "dedicated_snapshot_probe_required" : "snapshot_probe_not_configured",
        );
        if (feature === "launch-snapshot") continue;
      }
    }
    if ((!feature || feature === "subscription-account") && c.subscriptionAccount !== true) {
      record("subscription-account", c.provider, "not-run", "subscription_account_probe_not_configured");
      if (feature === "subscription-account") continue;
    }
    if (!feature && c.mcpResume !== true) record("mcp-resume", c.provider, "not-run", "mcp_resume_probe_not_enabled");
    if ((!feature || feature === "mcp" || feature === "mcp-resume") && (!c.mcp || !c.template)) {
      if (!feature || feature === "mcp") record("mcp", c.provider, "not-run", "mcp_probe_not_configured");
      if (feature === "mcp-resume" || (!feature && c.mcpResume === true))
        record("mcp-resume", c.provider, "not-run", "mcp_probe_not_configured");
      if (feature === "mcp" || feature === "mcp-resume") continue;
    }
    if ((feature === "mcp" || feature === "mcp-resume") && c.provider === "boat" && c.harness !== "opencode") {
      record(feature, c.provider, "not-run", "native_boat_mcp_evidence_probe_not_implemented");
      continue;
    }
    if ((!feature || feature === "application-secrets") && (!c.applicationSecret || !c.template)) {
      record("application-secrets", c.provider, "not-run", "secret_probe_not_configured");
      if (feature === "application-secrets") continue;
    }
    if (!feature && c.skillsResume !== true)
      record("skills-resume", c.provider, "not-run", "skills_resume_probe_not_enabled");
    if ((!feature || feature === "skills" || feature === "skills-resume") && (!c.skill || !c.template)) {
      if (!feature || feature === "skills") record("skills", c.provider, "not-run", "skills_probe_not_configured");
      if (feature === "skills-resume" || (!feature && c.skillsResume === true))
        record("skills-resume", c.provider, "not-run", "skills_probe_not_configured");
      if (feature === "skills" || feature === "skills-resume") continue;
    }
    if ((!feature || feature === "readable-variables") && (!c.readableVariable || !c.template)) {
      record("readable-variables", c.provider, "not-run", "readable_variable_probe_not_configured");
      if (feature === "readable-variables") continue;
    }
    if (!feature && c.routine !== true) record("routines", c.provider, "not-run", "routine_probe_not_enabled");
    if (feature === "routines" && !c.template) {
      record("routines", c.provider, "not-run", "routine_template_revision_not_configured");
      continue;
    }
    if ((!feature || feature === "templates") && !c.template) {
      record("templates", c.provider, "not-run", "template_revision_not_configured");
      if (feature === "templates") continue;
    }
    // A not-yet-implemented row must not allocate compute merely to print debt.
    if (
      feature &&
      !Object.hasOwn(steps, feature) &&
      ![
        "client-send",
        "client-stop",
        "resume-recall",
        "subscription-account",
        "usage",
        "exact-cost",
        "launch-snapshot",
        "templates",
        "routines",
        "readable-variables",
        "skills",
        "skills-resume",
        "application-secrets",
        "mcp",
        "mcp-resume",
      ].includes(feature) &&
      !requestedHarness
    )
      continue;
    if (feature === "github" && !c.githubRepository) {
      record("github", c.provider, "not-run", "github_repository_not_configured");
      continue;
    }
    let snapshotSourceVerified = false;
    let dockerSnapshot: { id: string; hostId: string; orgId: string; ownerId: string; image: string } | undefined;
    let option: LaunchProviderOption | undefined;
    let id: string | undefined;
    const templateClaims = new Set<string>();
    let templateIntentUnknown = false;
    let keyedLaunchUnconfirmed = false;
    let stopped = false;
    let deleted = false;
    let stopRequested = false;
    const memory = `PARITY_${crypto.randomUUID().replaceAll("-", "")}`;
    let afterResume = false;
    const measuredPrompts = new Set<string>();
    const retainedPrices = new Map<string, string>();
    let blocked: string | undefined;
    let blockedDiagnostic: Diagnostic | undefined;
    let clientStopEligible = false;
    const api = <T>(path: string, body: object = {}) => request<T>(path, { org: c.org, ...body });
    function dockerLaunchInput(requestId: string) {
      return {
        hostId: c.hostId,
        requestId,
        ...(dockerSnapshot ? { snapshotId: dockerSnapshot.id } : {}),
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
      };
    }

    async function launchOrdinary(provider: "modal" | "docker") {
      const started = io.now();
      const launchId = crypto.randomUUID();
      const requestKey = `post-deploy-smoke:${launchId}`;
      const step = `parity_${provider}_launch`;
      const timeoutMs = launchTimeouts[step] ?? 600_000;
      const budget = Math.min(deadline, requestDeadline ?? deadline);
      const remaining = budget - started;
      if (remaining <= 0) throw new Error("poll_limit_exceeded");

      async function claim(sandboxId: string) {
        id = sandboxId;
        await io.recordSandbox?.(c.org, sandboxId, requestKey, provider);
      }

      let result: { sandbox: { id: string; provider: string } };
      try {
        result = await request<typeof result>(
          "sandbox/launch",
          {
            org: c.org,
            provider,
            harness: c.harness,
            model: c.model,
            credentialId: c.modelAccountId,
            visibility: "private",
            ttlSeconds: 1800,
            ...(provider === "docker"
              ? dockerLaunchInput(launchId)
              : { golden: c.golden, connections: [], idempotencyKey: requestKey }),
            externalRef: requestKey,
          },
          Math.min(timeoutMs, remaining),
        );
      } catch (error) {
        const detail = diagnostic(error);
        if (
          !(error instanceof ParityError) ||
          ["outcome_unknown", "launch_response_unreadable"].includes(detail.code) ||
          (detail.httpStatus ?? 0) >= 500
        ) {
          const sandbox = await observeSmokeLaunch(Math.min(budget, io.now() + timeoutMs), io, async (remainingMs) => {
            const inventory = await request<{
              sandboxes?: { id: string; provider: string; externalRef: string; status: string }[];
            }>(
              "sandbox/list",
              { org: c.org, owner: "me", externalRef: requestKey },
              Math.min(5_000, remainingMs),
            ).catch(() => undefined);
            const rows = inventory?.sandboxes;
            const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
            if (
              row?.provider !== provider ||
              row.externalRef !== requestKey ||
              typeof row.id !== "string" ||
              !UUID.test(row.id) ||
              (provider === "docker" && row.id !== launchId)
            )
              return;
            if (!id) await claim(row.id);
            if (row.id === id && (row.status === "ready" || (provider === "docker" && row.status === "running")))
              return row;
          });
          if (sandbox) result = { sandbox };
          else {
            keyedLaunchUnconfirmed = id === undefined;
            throw new ParityError({ ...detail, requestKey });
          }
        } else throw new ParityError({ ...detail, requestKey });
      }
      if (typeof result.sandbox?.id !== "string" || !result.sandbox.id || result.sandbox.provider !== provider)
        throw new Error("invalid_launch_receipt");
      if (!id) await claim(result.sandbox.id);
      io.out(JSON.stringify({ step, provider, pass: true, elapsedMs: io.now() - started }));
      return result;
    }
    const readableUntil = Math.min(deadline, io.now() + 110_000);
    let mcp: Awaited<ReturnType<typeof prepareMcpProbe>> | undefined;
    let mcpRuntimeEpoch: string | undefined;
    let secret: Awaited<ReturnType<typeof prepareSecretProbe>> | undefined;
    let skills: Awaited<ReturnType<typeof prepareSkillsProbe>> | undefined;
    let readable: Awaited<ReturnType<typeof prepareReadableProbe>> | undefined;
    const readableApi = async <T>(path: string, body: object = {}) => {
      const previous = requestDeadline;
      requestDeadline = Math.min(readableUntil, previous ?? Number.POSITIVE_INFINITY);
      try {
        return await api<T>(path, body);
      } finally {
        requestDeadline = previous;
      }
    };
    const discoveryApi = [
      "client-send",
      "client-stop",
      "readable-variables",
      "skills",
      "skills-resume",
      "application-secrets",
      "mcp",
      "mcp-resume",
      "subscription-account",
    ].includes(feature ?? "")
      ? readableApi
      : api;
    async function verifyClientStop() {
      if (!id) throw Error("launch_not_available");
      const sandboxId = id,
        until = feature === "client-stop" ? readableUntil : Math.min(deadline, io.now() + 110_000),
        previous = requestDeadline;
      requestDeadline = until;
      try {
        await probeClientStop(
          { id: sandboxId, org: c.org, origin, token: env.ARMADA_TOKEN! },
          {
            fetch: io.fetch,
            now: io.now,
            sleep: io.sleep,
            until,
            dispatch: () => {
              stopRequested = true;
              stopped = false;
            },
            verified: (client) => {
              stopped = true;
              record(`client-stop-${client}`, c.provider, "pass");
            },
            resume: async () => {
              stopped = false;
              stopRequested = false;
              afterResume = true;
              try {
                if (c.provider === "docker") {
                  const result = await api<{ id?: string; status?: string }>("sandbox/resume", {
                    id: sandboxId,
                    request_id: crypto.randomUUID(),
                  });
                  if (result.id !== undefined && result.id !== sandboxId) throw Error("invalid_control_receipt");
                }
                await runTurn(true, true, until);
                await poll(
                  () => api<{ id: string; status: string }>("sandbox/status", { id: sandboxId }),
                  (value) => value.id === sandboxId && ["ready", "running"].includes(value.status),
                  110,
                  until,
                );
                record("client-stop-resume-prerequisite", c.provider, "pass");
              } catch (error) {
                const detail = diagnostic(error);
                record(
                  "client-stop-resume-prerequisite",
                  c.provider,
                  detail.quota ? "not-run" : "fail",
                  detail.quota ? "quota" : detail.code,
                  detail,
                );
                throw error;
              }
            },
          },
        );
        record("client-stop", c.provider, "pass");
      } catch (error) {
        const detail = diagnostic(error),
          status = detail.quota || detail.notRun ? "not-run" : "fail";
        if (error instanceof ClientSendError) {
          // Only a refusal of the business write, never a later status read, proves non-admission.
          if (error.writeRefused) stopRequested = false;
          record(`client-stop-${error.client}`, c.provider, status, detail.quota ? "quota" : detail.code, detail);
        }
        record("client-stop", c.provider, status, detail.quota ? "quota" : detail.code, detail);
        throw error;
      } finally {
        requestDeadline = previous;
      }
    }
    async function verifyClientSend() {
      if (!id) throw Error("launch_not_available");
      const until = feature === "client-send" ? readableUntil : Math.min(deadline, io.now() + 110_000);
      const previous = requestDeadline;
      requestDeadline = until;
      try {
        const detail = await api<{ id: string; conversationIds?: string[] }>("sandbox/detail", { id });
        if (io.now() > until) throw new ClientSendError("dashboard", "client_send_timeout");
        const conversations = detail?.conversationIds;
        if (
          detail?.id !== id ||
          !Array.isArray(conversations) ||
          conversations.length !== 1 ||
          typeof conversations[0] !== "string" ||
          !conversations[0] ||
          conversations[0].length > 512
        )
          throw new ClientSendError("dashboard", "client_send_conversation_unavailable");
        await probeClientSend(
          { id, org: c.org, origin, token: env.ARMADA_TOKEN!, conversationId: conversations[0] },
          {
            fetch: io.fetch,
            now: io.now,
            sleep: io.sleep,
            until,
            verified: (client) => record(`client-send-${client}`, c.provider, "pass"),
          },
        );
        record("client-send", c.provider, "pass");
      } catch (error) {
        if (error instanceof ClientSendError) {
          const detail = diagnostic(error),
            status = detail.quota || detail.notRun ? "not-run" : "fail";
          record(`client-send-${error.client}`, c.provider, status, detail.quota ? "quota" : detail.code, detail);
          record("client-send", c.provider, status, detail.quota ? "quota" : detail.code, detail);
        }
        throw error;
      } finally {
        requestDeadline = previous;
      }
    }
    async function verifySkills() {
      const probe = skills;
      if (!probe || !id) throw Error("invalid_skills_binding");
      const sandboxId = id;
      await poll(
        async () => {
          await probe.verify(sandboxId, c.provider, c.harness);
          return true;
        },
        (value) => value,
        1,
        readableUntil,
      );
    }
    async function verifyMcp() {
      const probe = mcp;
      if (!probe || !id) throw new McpProbeError("invalid_mcp_binding");
      const sandboxId = id;
      await poll(
        async () => {
          const evidence = await probe.verify(sandboxId, c.provider);
          if (c.provider === "boat") {
            const epoch = evidence.runtimeEpoch;
            if (!epoch || (afterResume && mcpRuntimeEpoch && BigInt(epoch) <= BigInt(mcpRuntimeEpoch)))
              throw new McpProbeError("invalid_mcp_receipt");
            mcpRuntimeEpoch = epoch;
          }
          return true;
        },
        (value) => value,
        1,
        readableUntil,
      );
    }
    async function checkUsage(promptId: string) {
      if (feature && !["usage", "exact-cost", "subscription-account"].includes(feature)) return;
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
        if (c.subscriptionAccount === true)
          observe("subscription-account", detail.quota ? "not-run" : "fail", "usage_unavailable", detail);
        if (!feature || feature === "exact-cost")
          observe("exact-cost", detail.quota ? "not-run" : "fail", "usage_unavailable", detail);
        return;
      }
      const proveSubscription = () => {
        if (c.subscriptionAccount !== true) return;
        const admitted = usage?.turns.filter((turn) => measuredPrompts.has(turn.promptId));
        const valid =
          usage?.cost?.classification === "included_in_subscription" &&
          usage.cost.basis === "api_equivalent" &&
          !!admitted?.length &&
          admitted.every(
            (turn) =>
              turn.pricing?.billing === "subscription" &&
              turn.pricing.basis === "api_equivalent" &&
              typeof turn.pricing.credentialId === "string" &&
              turn.pricing.credentialId.toLowerCase() === c.modelAccountId.toLowerCase() &&
              Number.isSafeInteger(turn.pricing.credentialVersion) &&
              (turn.pricing.credentialVersion ?? 0) > 0,
          );
        observe(
          "subscription-account",
          valid ? "pass" : "fail",
          valid ? "observed admitted subscription account" : "invalid_subscription_receipt",
        );
      };
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
          proveSubscription();
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
        proveSubscription();
      } catch (error) {
        const detail = diagnostic(error);
        observe("exact-cost", "fail", detail.code, detail);
        if (c.subscriptionAccount === true) observe("subscription-account", "fail", detail.code, detail);
      }
    }
    async function runTurn(recall = false, strictRecall = false, observationUntil?: number) {
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
      let finalParent: string | undefined;
      const finalAnswers = new Map<string, { text: string; eligible: boolean }>();
      let serverStarted: number | undefined;
      let serverFinished: number | undefined;
      let elapsedMs = 0;
      let polls = 0;
      try {
        await poll(
          () =>
            api<{
              cursor?: string;
              hasMore?: boolean;
              events: {
                id?: string;
                messageId?: string;
                textMode?: string;
                at?: number;
                kind: string;
                promptId?: string;
                status?: string;
                text?: string;
                partial?: boolean;
                parentToolUseId?: string;
                responseKind?: string;
                retracted?: boolean;
              }[];
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
            if (
              c.subscriptionAccount === true ||
              feature === "skills-resume" ||
              feature === "client-stop" ||
              observationUntil !== undefined
            ) {
              for (const event of page.events) {
                if (event.promptId !== turn.promptId || event.kind !== "message") continue;
                if (typeof event.id !== "string") throw new Error("invalid_turn_receipt");
                const key = event.messageId ?? event.id;
                if (!event.parentToolUseId && event.responseKind !== "tool_result") finalParent = key;
                const text =
                  event.textMode === "delta"
                    ? (finalAnswers.get(key)?.text ?? "") + (event.text ?? "")
                    : (event.text ?? "");
                finalAnswers.set(key, {
                  text: text.slice(0, 4096),
                  eligible:
                    text.length <= 4096 &&
                    event.partial === false &&
                    !event.parentToolUseId &&
                    event.responseKind !== "tool_result" &&
                    !event.retracted,
                });
              }
              const answer = finalParent ? finalAnswers.get(finalParent) : undefined;
              return (
                page.hasMore !== true &&
                finished &&
                answer?.eligible === true &&
                answer.text.trim() === (recall ? memory : "SMOKE_OK")
              );
            }
            answered ||= page.events.some(
              (e) =>
                e.promptId === turn.promptId &&
                e.kind === "message" &&
                (strictRecall
                  ? e.text === memory &&
                    e.partial === false &&
                    !e.parentToolUseId &&
                    e.responseKind !== "tool_result" &&
                    !e.retracted
                  : e.text?.includes(recall ? memory : "SMOKE_OK")),
            );
            return finished && answered;
          },
          600,
          Math.min(deadline, turnStarted + OBSERVATION_MS, observationUntil ?? Number.POSITIVE_INFINITY),
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
      // Bounded auxiliary wake turns are included in the later ordinary lifecycle usage read.
      if (observationUntil === undefined) await checkUsage(turn.promptId);
      else measuredPrompts.add(turn.promptId);
    }
    type IdleState = {
      id: string;
      status: string;
      idlePaused?: boolean;
      statusReason?: string | null;
      expiresAt: string | null;
      conversationIds: string[];
    };
    let idleBaseline: IdleState | undefined;
    const sameRetainedState = (value: IdleState) => {
      if (
        !idleBaseline ||
        value.id !== id ||
        value.expiresAt !== idleBaseline.expiresAt ||
        !Array.isArray(value.conversationIds) ||
        JSON.stringify([...value.conversationIds].sort()) !== JSON.stringify([...idleBaseline.conversationIds].sort())
      )
        throw new Error("invalid_idle_receipt");
    };
    async function observeIdle() {
      idleBaseline = await api<IdleState>("sandbox/detail", { id });
      if (
        idleBaseline.id !== id ||
        !["ready", "running"].includes(idleBaseline.status) ||
        !idleBaseline.expiresAt ||
        !Number.isFinite(Date.parse(idleBaseline.expiresAt)) ||
        !Array.isArray(idleBaseline.conversationIds) ||
        idleBaseline.conversationIds.length === 0
      )
        throw new Error("invalid_idle_receipt");
      if (idleDelay === undefined) throw new Error("invalid_idle_receipt");
      const until = Math.min(deadline, io.now() + idleDelay + 180_000);
      if (Date.parse(idleBaseline.expiresAt) <= until) throw new Error("invalid_idle_receipt");
      await poll(
        () => api<IdleState>("sandbox/detail", { id }),
        (value) => {
          sameRetainedState(value);
          if (value.status === "stopped") {
            if ((value.idlePaused !== undefined && value.idlePaused !== true) || value.statusReason !== "idle_paused")
              throw new Error("invalid_idle_receipt");
            return true;
          }
          if (!["ready", "running", "stopping"].includes(value.status)) throw new Error("invalid_idle_receipt");
          return false;
        },
        Math.ceil((until - io.now()) / 1000) + 1,
        until,
      );
      stopped = true;
    }

    async function controlTurn(action: "steer" | "interrupt") {
      if (!id) throw new Error("launch_not_available");
      const until = Math.min(deadline, io.now() + 110_000);
      const previous = requestDeadline;
      requestDeadline = until;
      try {
        const original = await api<{ promptId: string }>("sandbox/send", {
          id,
          prompt:
            "Use your terminal tool to run sleep 90. Wait for it to finish before replying CONTROL_ORIGINAL. Do not modify files.",
          ...(c.provider === "docker" ? { request_id: crypto.randomUUID() } : {}),
        });
        if (!original.promptId) throw new Error("invalid_turn_receipt");
        await poll(
          () =>
            api<{ prompt: { promptId: string; state: string } | null }>("sandbox/wait", {
              id,
              prompt_id: original.promptId,
              timeout_seconds: 0,
            }),
          (value) => {
            if (value.prompt === null) return false;
            if (value.prompt?.promptId !== original.promptId) throw new Error("control_turn_not_active");
            if (value.prompt.state === "queued") return false;
            if (value.prompt.state !== "running") throw new Error("control_turn_not_active");
            return true;
          },
          110,
          until,
        );
        const marker = `PARITY_STEER_${crypto.randomUUID().replaceAll("-", "")}`;
        const result = await api<{ id: string; interrupted?: boolean; delivery?: string; promptId?: string }>(
          `sandbox/${action}`,
          {
            id,
            ...(action === "steer"
              ? { text: `Cancel the waiting task. Reply with exactly ${marker} and nothing else. Do not use tools.` }
              : {}),
            ...(c.provider === "docker" ? { request_id: crypto.randomUUID() } : {}),
          },
        );
        if (
          result.id !== id ||
          (action === "interrupt"
            ? result.interrupted !== true
            : !["native", "restart"].includes(result.delivery ?? ""))
        )
          throw new Error("invalid_control_receipt");
        if (action === "interrupt") {
          await poll(
            () =>
              api<{ prompt: { promptId: string; state: string } | null }>("sandbox/wait", {
                id,
                prompt_id: original.promptId,
                timeout_seconds: 0,
              }),
            (value) => {
              if (value.prompt === null) return false;
              if (value.prompt?.promptId !== original.promptId) throw new Error("invalid_control_receipt");
              if (["finished", "failed"].includes(value.prompt.state)) throw new Error("invalid_control_receipt");
              return value.prompt.state === "interrupted";
            },
            110,
            until,
          );
        } else {
          // Boat can return a steer-record ID rather than the restarted run ID.
          // Match the unique redirected answer and terminal event on the SAME run.
          const terminal = new Map<string, string>();
          const lastParent = new Map<string, string>();
          const messages = new Map<string, { text: string; eligible: boolean }>();
          let cursor: string | undefined;
          await poll(
            () =>
              api<{
                cursor?: string;
                hasMore?: boolean;
                events: Array<{
                  id?: string;
                  messageId?: string;
                  textMode?: string;
                  kind: string;
                  promptId?: string;
                  status?: string;
                  text?: string;
                  partial?: boolean;
                  parentToolUseId?: string;
                  responseKind?: string;
                  retracted?: boolean;
                }>;
              }>("logs/read", {
                id,
                coalesce: true,
                ...(cursor ? { cursor } : {}),
              }),
            (page) => {
              if (!Array.isArray(page.events)) throw new Error("invalid_logs_receipt");
              cursor = page.cursor;
              for (const event of page.events) {
                if (!event.promptId) continue;
                if (event.kind === "prompt" && event.status) terminal.set(event.promptId, event.status);
                if (event.kind !== "message") continue;
                if (typeof event.id !== "string") throw new Error("invalid_control_receipt");
                const key = `${event.promptId}:${event.messageId ?? event.id}`;
                if (!event.parentToolUseId && event.responseKind !== "tool_result") lastParent.set(event.promptId, key);
                const text =
                  event.textMode === "delta"
                    ? (messages.get(key)?.text ?? "") + (event.text ?? "")
                    : (event.text ?? "");
                messages.set(key, {
                  text: text.slice(0, 4096),
                  eligible:
                    text.length <= 4096 &&
                    event.partial === false &&
                    !event.parentToolUseId &&
                    event.responseKind !== "tool_result" &&
                    !event.retracted,
                });
              }
              return (
                page.hasMore !== true &&
                [...lastParent].some(([prompt, key]) => {
                  const answer = messages.get(key);
                  return (
                    terminal.get(prompt) === "finished" && answer?.eligible === true && answer.text.trim() === marker
                  );
                })
              );
            },
            110,
            until,
          );
        }
      } finally {
        requestDeadline = previous;
      }
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
      const options = await discoveryApi<{
        providers: LaunchProviderOption[];
        modalRuntime?: { opencodeMcpProofVersion?: number };
        boatRuntime?: {
          opencodeVersion?: number;
          defaultPath?: string;
          enabled?: boolean;
          opencodeMcpProofVersion?: number;
          checkpointVersion?: number;
          resumeVersion?: number;
        };
        dockerRuntime?: { opencodeMcpProofVersion?: number };
      }>("launch/options");
      option = options.providers.find((p) => p.id === c.provider);
      if (!option) throw new Error("missing_provider_options");
      if (
        c.provider === "boat" &&
        c.harness === "opencode" &&
        (feature === "mcp" || feature === "mcp-resume") &&
        (!option.harnesses.includes("opencode") ||
          options.boatRuntime?.enabled !== true ||
          options.boatRuntime.defaultPath !== "runtime" ||
          options.boatRuntime.opencodeVersion !== 1)
      ) {
        record(feature, c.provider, "not-run", "boat_opencode_runtime_not_advertised");
        continue;
      }
      if (!option.harnesses.includes(c.harness as never)) throw new Error("harness_not_advertised");
      if (
        c.provider === "boat" &&
        c.harness === "opencode" &&
        (options.boatRuntime?.opencodeVersion !== 1 || options.boatRuntime.defaultPath !== "runtime")
      )
        throw new Error("boat_opencode_runtime_not_advertised");
      if (feature === "client-stop" || (!feature && c.clientStop === true)) {
        const missing = (["stop", "resume", "followupPrompts", "logs", "status"] as const).find(
          (name) => option!.capabilities[name] !== true,
        );
        if (missing) {
          record(
            "client-stop",
            c.provider,
            option.capabilities[missing] === false ? "unsupported" : "not-run",
            option.unsupportedReasons[missing] ?? `${missing}_required_for_client_stop_proof`,
          );
          if (feature === "client-stop") continue;
        } else clientStopEligible = true;
      }
      if (feature === "client-send") {
        const missing = (["followupPrompts", "logs"] as const).find((name) => option!.capabilities[name] !== true);
        if (missing) {
          record(
            "client-send",
            c.provider,
            option.capabilities[missing] === false ? "unsupported" : "not-run",
            option.unsupportedReasons[missing] ?? `${missing}_required_for_client_send_proof`,
          );
          continue;
        }
      }
      if (feature === "mcp" || feature === "mcp-resume") {
        if (feature === "mcp-resume") {
          if (
            c.provider === "boat" &&
            (options.boatRuntime?.checkpointVersion !== 1 || options.boatRuntime.resumeVersion !== 1)
          ) {
            record(feature, c.provider, "not-run", "boat_runtime_checkpoint_resume_not_advertised");
            continue;
          }
          const missing = (["stop", "resume", "followupPrompts", "logs"] as const).find(
            (name) => option!.capabilities[name] !== true,
          );
          if (missing) {
            record(
              feature,
              c.provider,
              option.capabilities[missing] === false ? "unsupported" : "not-run",
              option.unsupportedReasons[missing] ?? `${missing}_required_for_mcp_resume_proof`,
            );
            continue;
          }
        }
        if (
          c.harness === "opencode" &&
          (c.provider === "boat"
            ? options.boatRuntime
            : c.provider === "docker"
              ? options.dockerRuntime
              : options.modalRuntime
          )?.opencodeMcpProofVersion !== 1
        ) {
          record(feature, c.provider, "not-run", "opencode_mcp_native_proof_not_advertised");
          continue;
        }
        if (option.capabilities.mcp !== true || option.capabilities.followupPrompts === false) {
          record(
            feature,
            c.provider,
            option.capabilities.mcp === false || option.capabilities.followupPrompts === false
              ? "unsupported"
              : "not-run",
            "mcp_or_followup_not_available",
          );
          continue;
        }
        if (!c.template || !c.mcp || !isHarness(c.harness)) throw new McpProbeError("invalid_mcp_binding");
        mcp = await prepareMcpProbe(c.template, c.mcp, { request: readableApi, poll, until: readableUntil }, c.harness);
      }
      if (feature === "application-secrets") {
        if (option.capabilities.secrets !== true) {
          record(
            "application-secrets",
            c.provider,
            option.capabilities.secrets === false ? "unsupported" : "not-run",
            option.unsupportedReasons.secrets ?? "secret_delivery_not_advertised",
          );
          continue;
        }
        if (option.capabilities.followupPrompts === false) {
          record(
            "application-secrets",
            c.provider,
            "unsupported",
            option.unsupportedReasons.followupPrompts ?? "followup_required_for_secret_proof",
          );
          continue;
        }
        if (option.capabilities.exec === false) {
          record("application-secrets", c.provider, "not-run", "exec_required_for_secret_proof");
          continue;
        }
        if (!c.template || !c.applicationSecret) throw new SecretProbeError("invalid_secret_binding");
        secret = await prepareSecretProbe(c.template, c.applicationSecret, {
          request: readableApi,
          poll,
          until: readableUntil,
        });
      }
      if (feature === "skills" || feature === "skills-resume") {
        if (feature === "skills-resume") {
          const missing = (["stop", "resume", "followupPrompts", "logs", "exec"] as const).find(
            (name) => option!.capabilities[name] !== true,
          );
          if (missing) {
            record(
              "skills-resume",
              c.provider,
              option.capabilities[missing] === false ? "unsupported" : "not-run",
              option.unsupportedReasons[missing] ?? `${missing}_required_for_skills_resume_proof`,
            );
            continue;
          }
        }
        if (option.capabilities.exec === false) {
          record(feature, c.provider, "not-run", "exec_required_for_skills_proof");
          continue;
        }
        if (!c.template || !c.skill) throw Error("invalid_skills_binding");
        skills = await prepareSkillsProbe(c.template, c.skill, { request: readableApi });
      }
      if (feature === "readable-variables") {
        if (option.capabilities.variables === false) {
          record(
            "readable-variables",
            c.provider,
            "unsupported",
            option.unsupportedReasons.variables ?? "Readable variables unavailable (#1532).",
          );
          continue;
        }
        if (option.capabilities.exec === false) {
          record("readable-variables", c.provider, "not-run", "exec_required_for_readable_proof");
          continue;
        }
        if (!c.template || !c.readableVariable) throw new Error("invalid_template_receipt");
        readable = await prepareReadableProbe(c.template, c.readableVariable, {
          request: readableApi,
          poll,
          until: readableUntil,
        });
      }
      if (feature === "launch-snapshot" && c.provider === "docker") {
        if (option.capabilities.goldens !== true || !option.launchSources?.includes("golden")) {
          record(
            feature,
            c.provider,
            "unsupported",
            option.unsupportedReasons.goldens ?? "snapshot_launch_not_advertised",
          );
          continue;
        }
        const listed = await discoveryApi<{
          snapshots: Array<{
            id: string;
            provider: string;
            hostId: string;
            orgId: string;
            ownerId: string;
            visibility: string;
            status: string;
            hostAvailable: boolean;
            image: string;
          }>;
        }>("docker/snapshots/list");
        if (!Array.isArray(listed.snapshots)) throw new Error("invalid_snapshot_source");
        const matches = listed.snapshots.filter((snapshot) => snapshot?.id === c.snapshotId);
        if (!matches.length) {
          record(feature, c.provider, "not-run", "snapshot_not_visible_or_unavailable");
          continue;
        }
        const actor = await discoveryApi<{ userId: string }>("account/status");
        const snapshot = matches[0]!;
        if (
          matches.length !== 1 ||
          snapshot.provider !== "docker" ||
          snapshot.orgId !== c.org ||
          snapshot.hostId !== c.hostId ||
          snapshot.visibility !== "private" ||
          typeof actor.userId !== "string" ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(actor.userId) ||
          snapshot.ownerId !== actor.userId
        )
          throw new Error("invalid_snapshot_source");
        if (snapshot.status !== "ready" || snapshot.hostAvailable !== true) {
          record(feature, c.provider, "not-run", "snapshot_not_ready_on_host");
          continue;
        }
        if (typeof snapshot.image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(snapshot.image))
          throw new Error("invalid_snapshot_source");
        dockerSnapshot = snapshot;
        snapshotSourceVerified = true;
      }
      if ((!feature || feature === "launch-snapshot") && c.provider !== "docker") {
        const listed = await discoveryApi<{
          goldens: Array<{ id: string; name: string; provider: string; providerSnapshotId: string | null }>;
        }>("golden/list");
        if (!Array.isArray(listed.goldens)) throw new Error("invalid_snapshot_source");
        const matches = listed.goldens.filter(
          (golden) => golden.provider === c.provider && (golden.name === c.golden || golden.id === c.golden),
        );
        if (
          matches.length !== 1 ||
          typeof matches[0]?.providerSnapshotId !== "string" ||
          !matches[0].providerSnapshotId.trim()
        )
          throw new Error("invalid_snapshot_source");
        snapshotSourceVerified = true;
      }
      if (
        c.githubRepository &&
        (!feature || feature === "github") &&
        option.capabilities.github !== false &&
        c.provider !== "docker"
      ) {
        // Runtime GitHub grants are bound to the frozen golden repositories.
        // Do not allocate a sandbox whose grant cannot authorize this fixture.
        const configured = await discoveryApi<{ provider: string; repositories: { url: string }[] }>(
          "golden/size-policy",
          {
            golden: c.golden,
            provider: c.provider,
          },
        );
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
        const hosts = await discoveryApi<{ hosts: { id: string; state: string }[] }>("docker/hosts/list");
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
        (step === "stop" && !["steer", "interrupt"].includes(feature ?? "")) ||
        step === "delete" ||
        ((feature === "client-send" ||
          feature === "client-stop" ||
          feature === "github" ||
          feature === "launch-snapshot" ||
          feature === "templates" ||
          feature === "readable-variables" ||
          feature === "skills" ||
          feature === "skills-resume" ||
          feature === "application-secrets" ||
          feature === "mcp" ||
          feature === "mcp-resume" ||
          idleFeature ||
          requestedHarness) &&
          step === "send") ||
        (feature === "wake-on-send" && step === "idle-pause") ||
        ([
          "resume",
          "resume-recall",
          "usage",
          "exact-cost",
          "subscription-account",
          "skills-resume",
          "mcp-resume",
        ].includes(feature ?? "") &&
          ["send", "resume"].includes(step));
      if (!needed) continue;
      const selected = !feature || step === feature;
      if (idleUnavailable && (step === "idle-pause" || step === "wake-on-send")) continue;
      if (step === "github" && !c.githubRepository) {
        record("github", c.provider, "not-run", "github_repository_not_configured");
        continue;
      }
      if (option?.capabilities[capability] === false && !(feature === "skills" && step === "send")) {
        const reason = option.unsupportedReasons[capability];
        record(
          selected ? step : `prerequisite:${step}`,
          c.provider,
          reason ? "unsupported" : "fail",
          reason ?? "missing_unsupported_reason",
        );
        continue;
      }
      if (feature === "subscription-account" && io.now() >= readableUntil && !blocked) {
        blocked = "proof_budget_exhausted";
        blockedDiagnostic = { code: "poll_limit_exceeded", message: "Subscription proof budget exhausted." };
      }
      if ((feature === "skills-resume" || feature === "mcp-resume") && io.now() >= readableUntil && !blocked) {
        blocked = "proof_budget_exhausted";
        blockedDiagnostic = { code: "poll_limit_exceeded", message: "Template resume proof budget exhausted." };
      }
      // Cleanup operations still run after an earlier probe failed.
      if (blocked && !((step === "stop" || step === "delete") && id)) {
        record(
          selected ? step : `prerequisite:${step}`,
          c.provider,
          blockedDiagnostic?.quota || blockedDiagnostic?.notRun || blockedDiagnostic?.code === "unsupported"
            ? "not-run"
            : "fail",
          blockedDiagnostic?.quota ? "quota" : blocked,
          blockedDiagnostic,
        );
        continue;
      }
      const operationStarted = io.now();
      try {
        if (
          feature === "client-send" ||
          feature === "client-stop" ||
          feature === "skills" ||
          feature === "skills-resume" ||
          feature === "application-secrets" ||
          feature === "mcp" ||
          feature === "mcp-resume"
        )
          requestDeadline = step === "stop" || step === "delete" ? undefined : readableUntil;
        if (feature === "subscription-account" || feature === "skills-resume" || feature === "mcp-resume")
          requestDeadline = step === "delete" || (step === "stop" && blocked) ? undefined : readableUntil;
        if (step === "launch") {
          if (feature !== "routines") starts++;
          const result =
            feature === "routines"
              ? await (async () => {
                  const template = c.template;
                  if (!template) throw new Error("invalid_template_receipt");
                  try {
                    return {
                      sandbox: await probeRoutine(
                        { ...c, template },
                        {
                          now: io.now,
                          deadline,
                          poll,
                          out: io.out,
                          request: async <T>(path: string, body: object, until: number) => {
                            const previous = requestDeadline;
                            requestDeadline = until;
                            try {
                              return await api<T>(path, body);
                            } finally {
                              requestDeadline = previous;
                            }
                          },
                          claim: async (claimed) => {
                            if (templateClaims.has(claimed)) return;
                            templateClaims.add(claimed);
                            id ??= claimed;
                            starts++;
                            if (c.provider !== "boat")
                              await io.recordSandbox?.(
                                c.org,
                                claimed,
                                `post-deploy-smoke:${crypto.randomUUID()}`,
                                c.provider,
                              );
                          },
                        },
                      ),
                    };
                  } catch (error) {
                    if (error instanceof RoutineProbeError)
                      throw new ParityError({
                        code: error.code,
                        message: error.code.replaceAll("_", " "),
                        ...(error.code === "routine_due_outside_budget" ? { notRun: true } : {}),
                      });
                    throw error;
                  }
                })()
              : feature === "templates" ||
                  feature === "readable-variables" ||
                  feature === "skills" ||
                  feature === "skills-resume" ||
                  feature === "application-secrets" ||
                  feature === "mcp" ||
                  feature === "mcp-resume"
                ? await (async () => {
                    const template = c.template;
                    if (!template) throw new Error("invalid_template_receipt");
                    const input = {
                      id: template.id,
                      revision: template.revision,
                      requestKey: `smoke-template-${crypto.randomUUID()}`,
                      ttlSeconds: 1800,
                      skipSkillDefaults: true,
                    };
                    let uncertain = false;
                    templateIntentUnknown = true;
                    io.out(
                      JSON.stringify({ step: "parity_template_intent", provider: c.provider, org: c.org, ...input }),
                    );
                    type Receipt = {
                      state: string;
                      reason?: string;
                      id?: string;
                      provider?: string;
                      manifest?: {
                        templateId?: string;
                        revision?: number;
                        variableProvenance?: unknown;
                        skillReceipts?: unknown;
                        connections?: Array<{ id?: string; version?: number; generation?: number }>;
                        account?: { id?: string; version?: number };
                        golden?: { id?: string; name?: string; provider?: string } | null;
                        definition?: {
                          skills?: unknown;
                          secrets?: unknown;
                          connections?: unknown;
                          provider?: string;
                          harness?: string;
                          model?: string;
                          hostId?: string;
                          goldenId?: string | null;
                        };
                      };
                    };
                    const receipt = await poll(
                      async () => {
                        let value: Receipt;
                        try {
                          value = await api<Receipt>("templates/launch", input);
                        } catch (error) {
                          const detail = diagnostic(error);
                          if (
                            !detail.quota &&
                            ([
                              "transport_or_receipt_failed",
                              "outcome_unknown",
                              "unavailable",
                              "provider_unavailable",
                              "dependency_unavailable",
                              "sandbox_not_ready",
                            ].includes(detail.code) ||
                              [408, 425, 500, 502, 503, 504].includes(detail.httpStatus ?? 0))
                          ) {
                            uncertain = true;
                            return { state: "reconciling" };
                          }
                          const refusedBeforeAdmission =
                            detail.quota ||
                            ([400, 422].includes(detail.httpStatus ?? 0) &&
                              ["invalid", "invalid_request"].includes(detail.code)) ||
                            (detail.httpStatus === 401 && detail.code === "unauthorized") ||
                            (detail.httpStatus === 403 && detail.code === "forbidden") ||
                            ([404, 405].includes(detail.httpStatus ?? 0) &&
                              ["not_found", "unknown_route", "method_not_allowed"].includes(detail.code));
                          if (!uncertain && refusedBeforeAdmission) templateIntentUnknown = false;
                          throw error;
                        }
                        if (value.state !== "succeeded" && value.state !== "failed") uncertain = true;
                        // Journal the durable claimed sandbox before waiting for allocation acknowledgement.
                        const ownProvider =
                          value.provider === c.provider ||
                          (value.provider === undefined && value.manifest?.definition?.provider === c.provider);
                        if (value.id && ownProvider) {
                          templateIntentUnknown = false;
                          if (!templateClaims.has(value.id)) {
                            templateClaims.add(value.id);
                            id ??= value.id;
                            if (c.provider !== "boat")
                              await io.recordSandbox?.(
                                c.org,
                                value.id,
                                `post-deploy-smoke:${crypto.randomUUID()}`,
                                c.provider,
                              );
                          }
                          if (value.id !== id) throw new Error("invalid_template_receipt");
                        }
                        return value;
                      },
                      // This durable requestKey is replayed unchanged; never a new launch intent.
                      (value) => value.state === "succeeded" || value.state === "failed",
                      [
                        "readable-variables",
                        "skills",
                        "skills-resume",
                        "application-secrets",
                        "mcp",
                        "mcp-resume",
                        "subscription-account",
                      ].includes(feature ?? "")
                        ? 110
                        : 600,
                      [
                        "readable-variables",
                        "skills",
                        "skills-resume",
                        "application-secrets",
                        "mcp",
                        "mcp-resume",
                        "subscription-account",
                      ].includes(feature ?? "")
                        ? readableUntil
                        : Math.min(deadline, io.now() + OBSERVATION_MS),
                    );
                    if (
                      receipt.state === "failed" &&
                      receipt.reason &&
                      Object.hasOwn(TEMPLATE_REFUSAL_HELP, receipt.reason)
                    )
                      throw new ParityError({
                        code: receipt.reason,
                        message: TEMPLATE_REFUSAL_HELP[receipt.reason as keyof typeof TEMPLATE_REFUSAL_HELP],
                      });
                    const manifest = receipt.manifest;
                    if (
                      receipt.state !== "succeeded" ||
                      !id ||
                      receipt.id !== id ||
                      receipt.provider !== c.provider ||
                      manifest?.templateId !== input.id ||
                      manifest.revision !== input.revision ||
                      manifest.account?.id !== c.modelAccountId ||
                      !Number.isSafeInteger(manifest.account.version) ||
                      (manifest.account.version ?? 0) < 1 ||
                      manifest.definition?.provider !== c.provider ||
                      manifest.definition.harness !== c.harness ||
                      manifest.definition.model !== c.model ||
                      (c.provider === "docker"
                        ? manifest.definition.hostId !== c.hostId
                        : manifest.golden?.provider !== c.provider ||
                          (manifest.golden.name !== c.golden && manifest.golden.id !== c.golden) ||
                          manifest.definition.goldenId !== manifest.golden.id)
                    )
                      throw new Error("invalid_template_receipt");
                    readable?.verifyManifest(manifest);
                    skills?.verifyManifest(manifest);
                    secret?.verifyManifest(manifest);
                    mcp?.verifyManifest(manifest);
                    return { sandbox: { id, provider: receipt.provider } };
                  })()
                : c.provider === "modal" || (c.provider === "docker" && !dockerSnapshot)
                  ? await launchOrdinary(c.provider)
                  : await api<{
                      sandbox: {
                        id: string;
                        provider: string;
                        snapshotId?: string;
                        hostId?: string;
                        image?: string;
                        orgId?: string;
                        ownerId?: string;
                        visibility?: string;
                      };
                    }>("sandbox/launch", {
                      provider: c.provider,
                      harness: c.harness,
                      model: c.model,
                      credentialId: c.modelAccountId,
                      visibility: "private",
                      ttlSeconds: 1800,
                      ...(c.provider === "docker"
                        ? dockerLaunchInput(crypto.randomUUID())
                        : { golden: c.golden, connections: [] }),
                    });
          if (typeof result.sandbox?.id !== "string" || !result.sandbox.id || result.sandbox.provider !== c.provider)
            throw new Error("invalid_launch_receipt");
          id = result.sandbox.id;
          if (dockerSnapshot) {
            await io.recordSandbox?.(c.org, id, `post-deploy-smoke:${crypto.randomUUID()}`, "docker");
            const receipt = result.sandbox as {
              snapshotId?: string;
              hostId?: string;
              image?: string;
              orgId?: string;
              ownerId?: string;
              visibility?: string;
            };
            if (
              receipt.snapshotId !== dockerSnapshot.id ||
              receipt.hostId !== dockerSnapshot.hostId ||
              receipt.image !== dockerSnapshot.image ||
              receipt.orgId !== dockerSnapshot.orgId ||
              receipt.ownerId !== dockerSnapshot.ownerId ||
              receipt.visibility !== "private"
            )
              throw new Error("invalid_snapshot_source");
          }
        } else {
          if (!id) throw new Error("launch_not_available");
          if (step === "send") {
            if (feature === "client-send") {
              await runTurn();
              await verifyClientSend();
            } else if (feature === "mcp" || feature === "mcp-resume") {
              await verifyMcp();
              if (feature === "mcp-resume") {
                record("mcp-before-resume", c.provider, "pass");
                record("prerequisite:mcp", c.provider, "pass");
                record("mcp-resume", c.provider, "not-run", "resume_not_observed");
              } else record("mcp", c.provider, "pass");
              record("prerequisite:templates", c.provider, "pass");
            } else if (feature === "application-secrets") {
              if (!secret) throw new SecretProbeError("invalid_secret_binding");
              await secret.verify(id, c.provider);
              record("application-secrets", c.provider, "pass");
              record("prerequisite:templates", c.provider, "pass");
            } else if (feature === "skills" || feature === "skills-resume") {
              await verifySkills();
              if (feature === "skills-resume") {
                record("skills-before-resume", c.provider, "pass");
                record("prerequisite:skills", c.provider, "pass");
                record("skills-resume", c.provider, "not-run", "resume_not_observed");
              } else record("skills", c.provider, "pass");
              record("prerequisite:templates", c.provider, "pass");
            } else if (feature === "readable-variables") {
              if (!readable) throw new Error("invalid_template_receipt");
              await readable.verify(id, c.provider);
              record("readable-variables", c.provider, "pass");
              record("prerequisite:templates", c.provider, "pass");
            } else {
              await runTurn();
              if (io.accountProbe) await runTurn(true);
              if (!feature && c.clientSend === true) await verifyClientSend();
              if (!feature || requestedHarness) record(harnessFeature, c.provider, "pass");
              if ((!feature || feature === "launch-snapshot") && snapshotSourceVerified)
                record("launch-snapshot", c.provider, "pass");
              if (feature === "templates") record("templates", c.provider, "pass");
            }
          } else if (step === "idle-pause") {
            await observeIdle();
          } else if (step === "wake-on-send") {
            if (!idleBaseline || !stopped) throw new Error("invalid_idle_receipt");
            // Wake admission may activate compute even if its acknowledgement is lost.
            // Cleanup must no longer assume the earlier stopped observation is current.
            stopped = false;
            stopRequested = false;
            // Ordinary send, never an explicit resume. Preserve the original deadline and conversation.
            await runTurn(true, true);
            const awake = await api<IdleState>("sandbox/detail", { id });
            sameRetainedState(awake);
            if (
              !["ready", "running"].includes(awake.status) ||
              awake.idlePaused === true ||
              awake.statusReason === "idle_paused"
            )
              throw new Error("invalid_idle_receipt");
            stopped = false;
            stopRequested = false;
          } else if (step === "steer" || step === "interrupt") {
            await controlTurn(step);
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
          } else if (
            step === "stop" &&
            clientStopEligible &&
            (feature === "client-stop" || (!feature && c.clientStop === true))
          ) {
            await verifyClientStop();
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
            if (step === "stop" && feature === "mcp-resume" && c.provider === "boat" && c.harness === "opencode") {
              const requestId = crypto.randomUUID();
              const checkpoint = await api<{
                id: string;
                requestId: string;
                runtime: { kind: string; epoch: string };
                checkpoint: { state: string; watermark: number; acknowledgedSequence: number };
              }>("sandbox/checkpoint-runtime-v1", { id, request_id: requestId, runtimeVersion: 1 });
              const proof = checkpoint.checkpoint;
              if (
                checkpoint.id !== id ||
                checkpoint.requestId !== requestId ||
                checkpoint.runtime?.kind !== "armada" ||
                checkpoint.runtime.epoch !== mcpRuntimeEpoch ||
                proof?.state !== "complete" ||
                !Number.isSafeInteger(proof.watermark) ||
                proof.watermark < 0 ||
                proof.acknowledgedSequence !== proof.watermark
              )
                throw new Error("invalid_runtime_checkpoint_receipt");
            }
            if (step === "stop") stopRequested = true;
            const requestId = crypto.randomUUID();
            const invoke = () => api<{ status: string }>(`sandbox/${step}`, { id, request_id: requestId });
            let receipt: { status: string };
            if (step === "resume" && feature === "mcp-resume" && c.provider !== "docker") {
              await verifyMcp();
              receipt = { status: "ready" };
            } else if (step === "resume" && c.provider !== "docker") {
              await runTurn(feature !== "skills-resume");
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
            if (step === "resume" && feature === "mcp-resume") {
              if (c.provider === "docker") await verifyMcp();
              record("mcp-after-resume", c.provider, "pass");
              record("mcp-resume", c.provider, "pass");
            }
            if (step === "resume" && feature === "skills-resume") {
              if (c.provider === "docker") await runTurn();
              await verifySkills();
              record("skills-after-resume", c.provider, "pass");
              record("skills-resume", c.provider, "pass");
            }
            if (
              step === "resume" &&
              (!feature || ["resume-recall", "usage", "exact-cost", "subscription-account"].includes(feature))
            ) {
              if (c.provider === "docker") await runTurn(true);
              record("resume-recall", c.provider, "pass");
            }
          }
        }
        if (feature === "routines" && step === "launch") record("routines", c.provider, "pass");
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
          detail.quota || detail.notRun
            ? "not-run"
            : (step === "steer" || step === "interrupt") && detail.code === "unsupported"
              ? "unsupported"
              : "fail",
          detail.quota ? "quota" : detail.code,
          detail,
        );
        if ((feature === "skills-resume" || feature === "mcp-resume") && step === "resume") {
          const status = detail.quota || detail.notRun ? "not-run" : "fail";
          const kind = feature === "skills-resume" ? "skills" : "mcp";
          record(`${kind}-after-resume`, c.provider, status, detail.quota ? "quota" : detail.code, detail);
          record(feature, c.provider, status, detail.quota ? "quota" : detail.code, detail);
        }
        blocked = `${step}_failed`;
        blockedDiagnostic = detail;
        if (
          step === "resume" &&
          (!feature || ["resume-recall", "usage", "exact-cost", "subscription-account"].includes(feature))
        )
          record(
            "resume-recall",
            c.provider,
            detail.quota ? "not-run" : "fail",
            detail.quota ? "quota" : detail.code,
            detail,
          );
      }
    }
    if (
      (!feature || feature === "launch-snapshot") &&
      (c.provider !== "docker" || snapshotSourceVerified) &&
      report["launch-snapshot"]?.[c.provider]?.status !== "pass"
    ) {
      const source = ["launch", "send"]
        .map((step) => ({ step, cell: report[feature ? `prerequisite:${step}` : step]?.[c.provider] }))
        .find(({ cell }) => cell && cell.status !== "pass");
      record(
        "launch-snapshot",
        c.provider,
        "not-run",
        source ? `${source.step}: ${source.cell?.reason ?? source.cell?.status}` : "turn_not_observed",
        source?.cell?.diagnostic,
      );
    }
    if (
      (feature === "templates" ||
        feature === "routines" ||
        feature === "readable-variables" ||
        feature === "skills" ||
        feature === "skills-resume" ||
        feature === "application-secrets" ||
        feature === "mcp" ||
        feature === "mcp-resume") &&
      report[feature]?.[c.provider]?.status !== "pass" &&
      report[feature]?.[c.provider]?.status !== "fail"
    ) {
      const source = (
        feature === "skills-resume" || feature === "mcp-resume"
          ? ["launch", "send", "stop", "resume"]
          : ["launch", "send"]
      )
        .map((step) => ({ step, cell: report[`prerequisite:${step}`]?.[c.provider] }))
        .find(({ cell }) => cell && cell.status !== "pass");
      record(
        feature,
        c.provider,
        "not-run",
        source ? `${source.step}: ${source.cell?.reason ?? source.cell?.status}` : "turn_not_observed",
        source?.cell?.diagnostic,
      );
    }
    if ((!feature || requestedHarness) && report[harnessFeature]?.[c.provider]?.status !== "pass") {
      const source = ["launch", "send"]
        .map((step) => ({
          step,
          cell: report[feature ? `prerequisite:${step}` : step]?.[c.provider],
        }))
        .find(({ cell }) => cell && cell.status !== "pass");
      record(
        harnessFeature,
        c.provider,
        source?.cell?.status === "unsupported" ? "unsupported" : "not-run",
        source ? `${source.step}: ${source.cell?.reason ?? source.cell?.status}` : "turn_not_observed",
        source?.cell?.diagnostic,
      );
    }
    // These probes already share the provider's lifecycle sandbox. If a
    // prerequisite prevents observation, report that cause, not implementation debt.
    for (const name of ["resume-recall", "usage", "exact-cost", "subscription-account", "client-send", "client-stop"]) {
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
    if (
      feature === "client-send" ||
      feature === "client-stop" ||
      feature === "skills" ||
      feature === "skills-resume" ||
      feature === "application-secrets" ||
      feature === "mcp" ||
      feature === "mcp-resume" ||
      feature === "subscription-account"
    )
      requestDeadline = undefined;
    for (const cleanupId of new Set([...(id ? [id] : []), ...templateClaims])) {
      if (cleanupId !== id) {
        id = cleanupId;
        stopped = false;
        stopRequested = false;
        deleted = false;
      }
      try {
        if (!deleted) await deleteKnown();
        if (report.cleanup?.[c.provider]?.status !== "fail") record("cleanup", c.provider, "pass");
      } catch (error) {
        const detail = diagnostic(error);
        // Known resources remain unconfirmed even when the refusal is quota.
        record("cleanup", c.provider, "fail", "cleanup_unconfirmed", detail);
      }
      io.out(JSON.stringify({ step: "parity_cleanup", provider: c.provider, id, deleted }));
    }
    if (templateIntentUnknown || keyedLaunchUnconfirmed)
      record("cleanup", c.provider, "fail", "allocation_unconfirmed");
  }
  // A separate launch path needs its own allocation; never relabel an ordinary launch as template proof.
  if (!feature)
    for (const { c, probe } of cases.flatMap((c) => [
      ...(c.template
        ? [{ c, probe: c.readableVariable ? ("readable-variables" as const) : ("templates" as const) }]
        : []),
      ...(c.routine ? [{ c, probe: "routines" as const }] : []),
      ...(c.template && c.skill
        ? [{ c, probe: c.skillsResume ? ("skills-resume" as const) : ("skills" as const) }]
        : []),
      ...(c.template && c.applicationSecret ? [{ c, probe: "application-secrets" as const }] : []),
      ...(c.template && c.mcp ? [{ c, probe: c.mcpResume ? ("mcp-resume" as const) : ("mcp" as const) }] : []),
    ])) {
      if (io.now() >= deadline) {
        record(probe, c.provider, "not-run", "run_budget_exhausted");
        continue;
      }
      let child: { starts: number; features: typeof report } | undefined;
      await providerParitySmoke(
        { ...env, ARMADA_SMOKE_CASES: JSON.stringify([c]), GITHUB_STEP_SUMMARY: undefined },
        {
          ...io,
          deadline,
          out: (line) => {
            try {
              const value = JSON.parse(line);
              if (value.step === "provider_parity") child = value;
              else io.out(JSON.stringify({ ...value, probe }));
            } catch {
              /* Outer table owns the combined presentation. */
            }
          },
        },
        [...(productionBoat ? ["--production-boat"] : []), "--only", c.provider, "--feature", probe],
      );
      starts += child?.starts ?? 0;
      const cell = child?.features[probe]?.[c.provider];
      record(
        probe,
        c.provider,
        cell?.status ?? "fail",
        cell?.reason ?? (cell ? null : `${probe}_probe_unconfirmed`),
        cell?.diagnostic,
      );
      if (probe === "skills-resume" || probe === "mcp-resume") {
        const kind = probe === "skills-resume" ? "skills" : "mcp";
        for (const name of [`${kind}-before-resume`, `${kind}-after-resume`]) {
          const stage = child?.features[name]?.[c.provider];
          if (stage) record(name, c.provider, stage.status, stage.reason, stage.diagnostic);
        }
        const initial = child?.features[`prerequisite:${kind}`]?.[c.provider];
        record(
          kind,
          c.provider,
          initial?.status ?? "not-run",
          initial?.reason ?? (initial ? null : `${kind}_initial_delivery_not_observed`),
          initial?.diagnostic ?? cell?.diagnostic,
        );
      }
      if (probe === "readable-variables") {
        const template = child?.features["prerequisite:templates"]?.[c.provider];
        record(
          "templates",
          c.provider,
          template?.status ?? "not-run",
          template?.reason ?? (template ? null : "readable_variable_probe_not_observed"),
          template?.diagnostic ?? cell?.diagnostic,
        );
      }
      const cleanup = child?.features.cleanup?.[c.provider];
      if (cleanup) record(`${probe}-cleanup`, c.provider, cleanup.status, cleanup.reason, cleanup.diagnostic);
      // Failed prerequisites remain failures even when the template row is honestly unobserved.
      if (child && Object.values(child.features).some((providers) => providers[c.provider]?.status === "fail"))
        record(`${probe}-evidence`, c.provider, "fail", `${probe}_probe_failed`);
    }
  return publishParityReport(env, io, starts, report);
}

async function publishParityReport(
  env: NodeJS.ProcessEnv,
  io: Io,
  starts: number,
  report: Record<string, Partial<Record<Provider, Cell>>>,
): Promise<boolean> {
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
                  `${cell.status}${cell.diagnostic ? `: ${cell.reason}; HTTP ${cell.diagnostic.httpStatus ?? "n/a"}; ${cell.diagnostic.code}; ${cell.diagnostic.message}; elapsedMs=${cell.diagnostic.elapsedMs ?? "n/a"}; polls=${cell.diagnostic.polls ?? 0}; serverElapsedMs=${cell.diagnostic.serverElapsedMs ?? "unknown"}${cell.diagnostic.requestKey ? `; requestKey=${cell.diagnostic.requestKey}` : ""}${cell.diagnostic.requestId ? `; requestId=${cell.diagnostic.requestId}` : ""}` : cell.reason ? `: ${cell.reason}` : ""}`,
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
    `Launch attempts: ${starts} (one lifecycle launch per selected provider plus configured template/routine probes (readable-variable proof shares its template launch); resume may allocate provider compute).`,
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
  const details = [
    "",
    "## Account feature and cost details",
    "",
    "Cost reasons retain subscription inclusion, estimated/API-equivalent basis or explicit unknown; a passing quote check is not an invoice.",
    "",
    "| Account | Provider | Feature | Result |",
    "| --- | --- | --- | --- |",
  ];
  const markdown = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("|", "\\|")
      .replace(/[\r\n]+/g, " ");
  const detail = (account: string, provider: Provider, feature: string, result: string) =>
    details.push(`| ${account} | ${provider} | ${feature} | ${markdown(result)} |`);
  for (const account of Object.keys(accountMatrix) as Array<keyof typeof accountMatrix>) {
    accounts[account] = {};
    for (const provider of providers) {
      const c = cases.find((c) => c.account === account && c.provider === provider);
      const reason =
        c?.notRunReason ?? (account.endsWith("-morph") ? "no account configured" : "no account on staging");
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
        if (receipt) {
          for (const [feature, providers] of Object.entries(receipt)) {
            const cell = providers[provider];
            detail(
              account,
              provider,
              feature,
              cell ? `${cell.status}${cell.reason ? `: ${cell.reason}` : ""}` : "not-run: no observation",
            );
          }
        } else detail(account, provider, "probe", `${outcome}: no provider receipt`);
      } else detail(account, provider, "all", status);
      accounts[account]![provider] = result;
      table.push(`| ${account} | ${provider} | ${status} |`);
    }
  }
  io.out(JSON.stringify({ step: "accounts_parity", version: 1, accounts }));
  const summary = [...table, ...details].join("\n");
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  else io.out(summary);
  return passed;
}

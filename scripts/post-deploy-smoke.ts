import { type Harness, isHarness } from "../packages/core/src/harnesses.ts";
import { describeNativeFailure, promptFailureReason } from "../packages/core/src/native-failure.ts";
import { isSandboxPlacementProvider } from "../packages/core/src/sandbox-provider.ts";
import { shellQuote as quote } from "../packages/core/src/shell-quote.ts";
import { providerParitySmoke } from "./provider-parity-smoke.ts";
import {
  confirmsCleanupStop,
  deleteSmokeReceipts,
  readSmokeJournal,
  type SmokeSandboxReceipt,
  STAGING_ORIGIN,
  saveSmokeJournal,
} from "./smoke-sandbox-cleanup.ts";
import { timedSmokeStep } from "./smoke-step.ts";
import { BOAT_STAGING_NOTICE, smokeReceiptProvider, stagingSmokeCases } from "./staging-smoke-policy.ts";
/** API-only smoke; ARMADA_SMOKE=create_real_compute explicitly authorizes compute.
 * ARMADA_URL must be an HTTPS origin; ARMADA_TOKEN is the only credential.
 * ARMADA_SMOKE_CASES is a JSON array of {provider, harness, org, golden, model,
 * modelAccountId, repo, goldenId?, reasoningEffort?}. golden is a launch name;
 * repo is an absolute sandbox cwd for exec.
 * --templates-skills requires goldenId; optional
 * publicSkill/privateSkill exact pins enable install checks. No provider credentials or DB access.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_FAILURE_STATUS, type ApiFailureCode } from "../packages/core/src/api-failure.ts";
import { parseLaunchAdmissionReceipt } from "../packages/core/src/contract/launch-response.ts";
import { DefaultSkillSmokeFailure, readDefaultPins, verifyDefaultReceipts } from "./default-skill-smoke.ts";
import { ExpirySmokeFailure, runExpiryCase } from "./expiry-smoke.ts";
import { helperProbe, skillpackProbe } from "./golden-runtime-smoke.ts";
import { createScopedProbe, ScopedAccessSmokeFailure } from "./scoped-access-smoke.ts";
import deadlineTable from "./smoke-deadlines.json";
import { deadlinesFor, SMOKE_POLL_INTERVAL_MS, USAGE_STATUS_MIN_REQUEST_MS } from "./smoke-deadlines.ts";
import { modalSmokeSetupFailed, observeSmokeLaunch } from "./smoke-launch.ts";
import { runTemplateSkillCase, TemplateSkillSmokeFailure, verifyReceipts } from "./template-skill-smoke.ts";
import { runVaultCase, VaultSmokeFailure } from "./vault-smoke.ts";

type Code =
  | ApiFailureCode
  | "sandbox_not_ready"
  | "modal_launch_setup_failed"
  | "invalid_configuration"
  | "compute_opt_in_required"
  | "request_failed"
  | "invalid_response"
  | "api_failed"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "unavailable"
  | "unsupported"
  | "poll_limit_exceeded"
  | "model_authentication_refused"
  | "model_timeout"
  | "turn_failed"
  | "exec_failed"
  | "invalid_receipt"
  | "provider_not_stopped"
  | "pair_disabled"
  | "operation_failed"
  | "continuity_failed"
  | "preservation_failed"
  | "invalid"
  | "no_running_turn"
  | "steer_not_refused"
  | "list_status_mismatch";
const API_CODES = new Set<Code>([
  ...(Object.keys(API_FAILURE_STATUS) as ApiFailureCode[]),
  "sandbox_not_ready",
  "no_running_turn",
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_request",
  "invalid",
  "conflict",
  "unavailable",
  "unsupported",
]);
class SmokeFailure extends Error {
  constructor(
    readonly code: Code,
    readonly status?: number,
    readonly waitResponse?: Record<string, string | boolean | number>,
    readonly launchResponse?: { httpStatus?: number; timeoutMs: number; requestId?: string; requestKey?: string },
    readonly transportTimeoutMs?: number,
    readonly statusResponse?: { httpStatus: number; requestId?: string },
  ) {
    super(code);
  }
}
class CredentialListSmokeFailure extends SmokeFailure {
  constructor(
    failure: SmokeFailure,
    readonly credentialList: {
      phase: "headers" | "body";
      httpStatus?: number;
      requestId?: string;
      timeoutMs?: number;
    },
  ) {
    super(failure.code, failure.status, undefined, undefined, failure.transportTimeoutMs);
  }
}
function jsonShape(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
function fail(code: Code): never {
  throw new SmokeFailure(code);
}
interface SmokeCase {
  provider: "modal";
  harness: Harness;
  org: string;
  golden: string;
  model: string;
  modelAccountId: string;
  scriptedModelAccountId?: string;
  repo: string;
  goldenId?: string;
  reasoningEffort?: string;
  disposableRepository?: string;
  publicSkill?: string;
  privateSkill?: string;
}
type DockerModelCase = Pick<SmokeCase, "org" | "model" | "modelAccountId"> & {
  provider: "docker";
  harness: "codex";
  hostId: string;
};
type RealModelCase = SmokeCase | DockerModelCase;
type RealModelLaunchSource = { golden: string; connections: [] } | { hostId: string };
const smokeLaunch = {
  modal: { ready: ["ready"], waitForRecoveredSetup: true },
  docker: { ready: ["ready", "running"], waitForRecoveredSetup: false },
};
interface SmokeIo {
  fetch: (url: string, init: RequestInit, receipt?: "admission") => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  out: (line: string) => void;
  recordSandbox?: (org: string, id: string, key: string, provider?: "modal" | "docker") => Promise<void>;
  recordSandboxDelete?: (org: string, id: string, accepted: boolean) => void;
}
const OBSERVED_SANDBOX_STATUSES: readonly string[] = [
  "starting",
  "ready",
  "running",
  "stopping",
  "stopped",
  "failed",
  "deleted",
];
const POLLS = 120;
/** A template launch answers only once the whole launch finished, but its sandbox is listed before. */
const TEMPLATE_LAUNCH_TIMEOUT_MS = 600_000;
/**
 * Longest a scoped probe waits for in-flight sibling launches to explain an otherwise unattributed
 * row: the longest launch request timeout, so a slow but valid sibling launch is never misreported.
 */
const SIBLING_ATTRIBUTION_WAIT_MS = TEMPLATE_LAUNCH_TIMEOUT_MS;
const SANDBOX_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const LAUNCH_PATH = /^(?:sandbox\/launch|templates\/launch)$/;
type Lane =
  | "templates"
  | "expiry"
  | "lifecycle"
  | "scoped"
  | "real-model"
  | "github-runtime"
  | "vault"
  | "default-skills";

/** Wait for every concurrent unit, so all cleanups finish before the journal sweep; a thrown unit still throws. */
async function settled(units: Promise<boolean>[]): Promise<boolean> {
  const results = await Promise.allSettled(units);
  const thrown = results.find((result) => result.status === "rejected");
  if (thrown) throw thrown.reason;
  return results.every((result) => result.status === "fulfilled" && result.value);
}
const PROMPT = "Reply with exactly SMOKE_OK and do not use tools.";

/**
 * Sandboxes one smoke run launched through the owner API. Concurrent lanes share a golden,
 * so the scoped probe's snapshot diff must tell these siblings apart from unaccounted
 * sandboxes. A handle is recorded before its receipt is validated, like the cleanup journal.
 * A launch that fails without a handle may still have created a sandbox: it is counted as
 * lost, so a probe can say its unattributed IDs may belong to another lane.
 */
export function createLaunchTracker() {
  const ids = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let lost = false;
  let wake = () => {};
  let changed = new Promise<void>((resolve) => (wake = resolve));
  const notify = () => {
    wake();
    changed = new Promise<void>((resolve) => (wake = resolve));
  };
  return {
    /** `launch` calls `record` with the parsed response body before validating it. */
    track<T>(path: string, launch: (record: (receipt: unknown) => void) => Promise<T>): Promise<T> {
      if (!LAUNCH_PATH.test(path)) return launch(() => {});
      let handled = false;
      const promise = launch((receipt) => {
        const value = receipt as { sandbox?: { id?: unknown }; id?: unknown } | null;
        const id = value?.sandbox?.id ?? value?.id;
        if (typeof id === "string" && id) {
          ids.add(id);
          handled = true;
          notify();
        }
      });
      pending.add(promise);
      promise.then(
        () => {
          pending.delete(promise);
          notify();
        },
        () => {
          pending.delete(promise);
          if (!handled) lost = true;
          notify();
        },
      );
      return promise;
    },
    /**
     * Call after a list read with the rows nothing else explains: any sibling among them came
     * from a launch already in flight. Returns once every candidate has a handle, no launch is in
     * flight, or `expired()` holds; `tick()` paces that check while launches stay pending.
     */
    async siblings(
      candidates: ReadonlySet<string>,
      expired: () => boolean,
      tick: () => Promise<void>,
    ): Promise<ReadonlySet<string>> {
      while (pending.size && [...candidates].some((id) => !ids.has(id)) && !expired())
        await Promise.race([changed, tick()]);
      return new Set(ids);
    },
    /** Whether a launch failed without a handle or is still in flight; read after `siblings()`. */
    lostLaunch: () => lost || pending.size > 0,
  };
}

/**
 * Runs actions that share a key one after another, in call order; different keys stay concurrent.
 * A failed action releases the key like a successful one. An action may call `release` to let
 * the next action with its key start before it finishes.
 */
export function createKeyedQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, action: (release: () => void) => Promise<T>): Promise<T> => {
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const result = (tails.get(key) ?? Promise.resolve()).then(() => action(release));
    const tail = Promise.race([
      released,
      result.then(
        () => {},
        () => {},
      ),
    ]);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

/** Parse the tar in memory; validate only its selected Git pack in an isolated disposable object store. */
async function verifyRecovery(archive: string, repo: string, commit: string) {
  if (archive.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(archive)) fail("preservation_failed");
  const bytes = Buffer.from(archive, "base64");
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "");
    const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/s, "").trim();
    if (!/^[0-7]+$/.test(sizeText)) fail("preservation_failed");
    const size = Number.parseInt(sizeText, 8);
    if (offset + 512 + size > bytes.length) fail("preservation_failed");
    entries.set(name, bytes.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  try {
    const manifest = JSON.parse(entries.get("manifest.json")?.toString() ?? "");
    const entry = manifest.repositories.find((entry: { path: string }) => entry.path === repo);
    if (
      manifest.version !== 2 ||
      entry?.head !== commit ||
      entry.bundle !== true ||
      !/^repo-\d+$/.test(entry.directory)
    )
      fail("preservation_failed");
    const bundle = entries.get(`${entry.directory}/commits.bundle`);
    const boundary = bundle?.indexOf(Buffer.from("\n\n")) ?? -1;
    if (!bundle || boundary < 0) fail("preservation_failed");
    const header = bundle.subarray(0, boundary).toString();
    if (!header.split("\n").includes(`${commit} HEAD`)) fail("preservation_failed");
    const directory = await mkdtemp(join(tmpdir(), "armada-smoke-recovery-"));
    try {
      async function git(args: string[], input?: Buffer) {
        const child = Bun.spawn(["git", ...args], {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            TMPDIR: directory,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
          stdin: input ? input : "ignore",
          stdout: "ignore",
          stderr: "ignore",
          timeout: 10_000,
        });
        if ((await child.exited) !== 0) fail("preservation_failed");
      }
      await git(["init", "--bare", "--quiet", "."]);
      // Index the pack directly: incremental bundles legitimately omit prerequisite
      // parents/trees. Unlike bundle verify/fsck, this does not require connectivity.
      // Git still verifies pack integrity, object hashes and any in-pack deltas.
      await git(["index-pack", "--stdin"], bundle.subarray(boundary + 2));
      await git(["cat-file", "commit", commit]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } catch {
    fail("preservation_failed");
  }
}

/** Operator entrypoint; injected I/O also permits fake-API validation without compute. */
async function runPostDeploySmoke(env: NodeJS.ProcessEnv, args: readonly string[], io: SmokeIo): Promise<boolean> {
  function report(
    index: number,
    step: string,
    error?: unknown,
    elapsedMs?: number,
    lane?: Lane,
    provider?: RealModelCase["provider"],
  ) {
    io.out(
      JSON.stringify({
        case: index,
        ...(lane ? { lane, provider } : {}),
        step,
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
        pass: error === undefined,
        ...(error === undefined
          ? {}
          : {
              code:
                error instanceof SmokeFailure ||
                error instanceof TemplateSkillSmokeFailure ||
                error instanceof DefaultSkillSmokeFailure ||
                error instanceof ScopedAccessSmokeFailure ||
                error instanceof ExpirySmokeFailure ||
                error instanceof VaultSmokeFailure
                  ? error.code
                  : "invalid_response",
              ...(error instanceof TemplateSkillSmokeFailure ? error.details : {}),
              ...(error instanceof CredentialListSmokeFailure ? { credentialList: error.credentialList } : {}),
              ...(error instanceof SmokeFailure && error.launchResponse
                ? { launchResponse: error.launchResponse }
                : {}),
              ...(error instanceof SmokeFailure && error.waitResponse ? { waitResponse: error.waitResponse } : {}),
            }),
      }),
    );
  }
  let origin: string;
  let cases: SmokeCase[];
  const github = args.includes("--github-runtime");
  const preservation = args.includes("--work-preservation");
  const defaultSkills = args.includes("--default-skills");
  const scopedAccess = args.includes("--scoped-access");
  const goldenRuntime = args.includes("--golden-runtime");
  const templatesSkills = args.includes("--templates-skills");
  const vault = args.includes("--vault");
  const lifecycle = args.includes("--lifecycle");
  const githubRefresh = args.includes("--github-refresh");
  const expiry = args.includes("--expiry");
  const realModel = args.includes("--real-model");
  let realModelCases: { item: RealModelCase; source: RealModelLaunchSource }[] = [];
  try {
    if (env.ARMADA_SMOKE !== "create_real_compute") fail("compute_opt_in_required");
    if (
      (realModel && args.length > 1 && !lifecycle) ||
      ((defaultSkills || scopedAccess) && !preservation) ||
      (githubRefresh && !lifecycle) ||
      (expiry && !lifecycle && args.length > 1) ||
      (goldenRuntime && templatesSkills && !preservation && !lifecycle) ||
      (github &&
        (preservation ||
          templatesSkills ||
          defaultSkills ||
          scopedAccess ||
          githubRefresh ||
          goldenRuntime ||
          expiry ||
          lifecycle ||
          vault)) ||
      args.some(
        (arg) =>
          arg !== "--github-runtime" &&
          arg !== "--work-preservation" &&
          arg !== "--templates-skills" &&
          arg !== "--default-skills" &&
          arg !== "--scoped-access" &&
          arg !== "--golden-runtime" &&
          arg !== "--lifecycle" &&
          arg !== "--github-refresh" &&
          arg !== "--expiry" &&
          arg !== "--vault" &&
          arg !== "--real-model",
      ) ||
      !env.ARMADA_URL ||
      !env.ARMADA_TOKEN ||
      !env.ARMADA_SMOKE_CASES
    )
      fail("invalid_configuration");
    const url = new URL(env.ARMADA_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      fail("invalid_configuration");
    origin = url.origin;
    if (
      (preservation ||
        templatesSkills ||
        defaultSkills ||
        scopedAccess ||
        goldenRuntime ||
        expiry ||
        lifecycle ||
        vault ||
        realModel) &&
      origin !== "https://armada-mcp-staging.up.railway.app"
    )
      fail("invalid_configuration");
    const parsed: unknown = JSON.parse(env.ARMADA_SMOKE_CASES);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) fail("invalid_configuration");
    const modalCases = [];
    const dockerCases = [];
    for (const item of parsed) {
      if (item?.provider === "docker") dockerCases.push(item);
      else modalCases.push(item);
    }
    if (!modalCases.length) fail("invalid_configuration");
    if (realModel) {
      const modal = modalCases.filter((item) => item?.harness === "codex");
      const host = dockerCases[0];
      if (
        modal.length !== 1 ||
        dockerCases.length !== 1 ||
        host.harness !== "codex" ||
        [host.org, host.hostId, host.modelAccountId].some(
          (value) => typeof value !== "string" || !SANDBOX_ID.test(value),
        ) ||
        typeof host.model !== "string" ||
        !host.model.trim() ||
        [modal[0].org, modal[0].modelAccountId].some((value) => typeof value !== "string" || !SANDBOX_ID.test(value)) ||
        [modal[0].modelAccountId, host.modelAccountId].some(
          (account) => account.toLowerCase() === modal[0].scriptedModelAccountId?.toLowerCase(),
        ) ||
        [host.model, modal[0].model].some(
          (model) => typeof model !== "string" || model.trim().toLowerCase() === "scripted",
        )
      )
        fail("invalid_configuration");
      realModelCases = [
        { item: modal[0], source: { golden: modal[0].golden, connections: [] } },
        { item: host, source: { hostId: host.hostId } },
      ];
    }
    for (const item of modalCases) {
      if (
        !item ||
        typeof item !== "object" ||
        item.provider !== "modal" ||
        !isHarness(item.harness) ||
        ["org", "golden", "model", "modelAccountId", "repo"].some(
          (key) => typeof item[key] !== "string" || !item[key].trim(),
        ) ||
        !item.repo.startsWith("/") ||
        (scopedAccess &&
          item.harness === "codex" &&
          (typeof item.scriptedModelAccountId !== "string" ||
            item.scriptedModelAccountId.toLowerCase() === item.modelAccountId.toLowerCase() ||
            [item.org, item.goldenId, item.modelAccountId, item.scriptedModelAccountId].some(
              (value) => typeof value !== "string" || !SANDBOX_ID.test(value),
            ))) ||
        (defaultSkills &&
          (typeof item.goldenId !== "string" ||
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.goldenId) ||
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.org))) ||
        (vault && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.org)) ||
        (item.reasoningEffort !== undefined &&
          (typeof item.reasoningEffort !== "string" || !item.reasoningEffort.trim()))
      )
        fail("invalid_configuration");
    }
    if (templatesSkills) {
      for (const item of modalCases) {
        if (
          typeof item.goldenId !== "string" ||
          !item.goldenId.trim() ||
          (item.publicSkill !== undefined &&
            (typeof item.publicSkill !== "string" ||
              !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+@\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(item.publicSkill))) ||
          (item.privateSkill !== undefined &&
            (typeof item.privateSkill !== "string" ||
              !/^[A-Za-z0-9_-]+@\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(item.privateSkill)))
        )
          fail("invalid_configuration");
      }
    }
    if (github) {
      if (
        env.ARMADA_URL !== "https://armada-mcp-staging.up.railway.app" ||
        env.ARMADA_SMOKE_GITHUB_GATE !== "true" ||
        !/^[a-f0-9]{40}$/.test(env.ARMADA_SMOKE_SERVER_REVISION ?? "") ||
        !/^[a-f0-9]{40}$/.test(env.ARMADA_SMOKE_RUNTIME_REVISION ?? "")
      )
        fail("invalid_configuration");
      const pairs = new Set(modalCases.map((item) => `${item.provider}/${item.harness}`));
      if (modalCases.length !== 2 || pairs.size !== 2) fail("invalid_configuration");
      for (const item of modalCases) {
        if (
          typeof item.disposableRepository !== "string" ||
          !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(item.disposableRepository)
        )
          fail("invalid_configuration");
      }
    }
    cases = modalCases.map((item) =>
      defaultSkills || (scopedAccess && item.harness === "codex")
        ? {
            ...item,
            org: item.org.toLowerCase(),
            goldenId: item.goldenId.toLowerCase(),
            modelAccountId: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.modelAccountId)
              ? item.modelAccountId.toLowerCase()
              : item.modelAccountId,
          }
        : item,
    );
  } catch (error) {
    report(0, "configure", error instanceof SmokeFailure ? error : new SmokeFailure("invalid_configuration"));
    return false;
  }
  const deadline = io.now() + 35 * 60_000;
  const cleanupDeadline = deadline + 5 * 60_000;
  const protectedCanaries = new Set<string>();
  const launches = createLaunchTracker();
  type UsageRead = { deadline: number; onDispatch: () => void };
  function send<T>(
    cleaning: boolean,
    path: string,
    body?: unknown,
    key?: string,
    timeoutMs = 120_000,
    usageRead?: UsageRead,
  ): Promise<T> {
    return launches.track(path, (record) =>
      transport<T>(cleaning, path, body, key, timeoutMs, record, false, usageRead),
    );
  }
  /** Each concurrent unit owns its cleanup flag; one unit's cleanup never moves another unit's deadline. */
  function createLane(provider: RealModelCase["provider"], lane: Lane) {
    const budgets = deadlinesFor(deadlineTable, provider, lane);
    let cleaning = false;
    let stepUntil: number | undefined;
    return {
      budgets,
      poll: <T>(read: PollRead<T>, done: (value: T) => boolean, options: PollOptions = {}) =>
        poll(read, done, options, options.step === undefined ? undefined : budgets[options.step]),
      request: <T>(path: string, body?: unknown, key?: string, timeoutMs?: number, usageRead?: UsageRead) => {
        if (stepUntil === undefined) return send<T>(cleaning, path, body, key, timeoutMs, usageRead);
        const remaining = stepUntil - io.now();
        if (remaining <= 0) fail("poll_limit_exceeded");
        return send<T>(cleaning, path, body, key, Math.min(timeoutMs ?? remaining, remaining), usageRead);
      },
      withStepDeadline: async <T>(
        name: string,
        action: (until?: number) => Promise<T>,
        { measureCleanup = false } = {},
      ) => {
        const budget = budgets[name];
        if ((cleaning && !measureCleanup) || budget === undefined) return action();
        stepUntil = Math.min(cleaning ? cleanupDeadline : deadline, io.now() + budget);
        try {
          const result = await action(stepUntil);
          if (io.now() > stepUntil) fail("poll_limit_exceeded");
          return result;
        } finally {
          stepUntil = undefined;
        }
      },
      withCleanup: async <T>(action: () => Promise<T>): Promise<T> => {
        cleaning = true;
        try {
          return await action();
        } finally {
          cleaning = false;
        }
      },
    };
  }
  async function transport<T>(
    cleaning: boolean,
    path: string,
    body: unknown,
    key: string | undefined,
    timeoutMs: number,
    record: (receipt: unknown) => void,
    requireSandboxUuid = false,
    usageRead?: UsageRead,
    receipt?: "admission",
  ): Promise<T> {
    const outerDeadline = cleaning ? cleanupDeadline : deadline;
    const remaining = Math.min(outerDeadline, usageRead?.deadline ?? outerDeadline) - io.now();
    const requestTimeoutMs = Math.min(timeoutMs, remaining);
    if (requestTimeoutMs <= 0 || (usageRead !== undefined && requestTimeoutMs < USAGE_STATUS_MIN_REQUEST_MS))
      fail("poll_limit_exceeded");
    const sandboxLaunch = path === "sandbox/launch";
    const signal = AbortSignal.timeout(requestTimeoutMs);
    const timedOut = (error: unknown) =>
      signal.aborted || (error instanceof DOMException && error.name === "TimeoutError");
    let receivedResponse: Response | undefined;
    try {
      usageRead?.onDispatch();
      const response = await io.fetch(
        `${origin}/api/v1/${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${env.ARMADA_TOKEN}`,
            accept: "application/json",
            "content-type": "application/json",
            ...(key ? { "idempotency-key": key } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal,
        },
        receipt,
      );
      receivedResponse = response;
      const sandboxStatus = path === "sandbox/status";
      const requestId = sandboxLaunch || sandboxStatus ? response.headers.get("x-request-id") : null;
      const correlation =
        requestId && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(requestId) ? { requestId } : {};
      const launchResponse = sandboxLaunch
        ? { httpStatus: response.status, timeoutMs: requestTimeoutMs, ...correlation }
        : undefined;
      const statusResponse = sandboxStatus ? { httpStatus: response.status, ...correlation } : undefined;
      if (!response.ok) {
        const payload = (await response.json().catch((error: unknown) => {
          if (timedOut(error))
            throw new SmokeFailure(
              "api_failed",
              response.status,
              undefined,
              launchResponse,
              requestTimeoutMs,
              statusResponse,
            );
          return null;
        })) as { error?: { code?: unknown } } | null;
        if ([...protectedCanaries].some((value) => JSON.stringify(payload).includes(value)))
          throw new VaultSmokeFailure("secret_exposed");
        const code = payload?.error?.code;
        throw new SmokeFailure(
          typeof code === "string" && API_CODES.has(code as Code) ? (code as Code) : "api_failed",
          response.status,
          undefined,
          launchResponse,
        );
      }
      type ResponseBody = {
        sandbox?: { id?: unknown; provider?: unknown; externalRef?: unknown };
        state?: unknown;
        id?: unknown;
        provider?: unknown;
      } | null;
      let result: ResponseBody;
      try {
        result = (await response.json()) as ResponseBody;
      } catch (error) {
        if (timedOut(error))
          throw new SmokeFailure(
            "request_failed",
            response.status,
            undefined,
            launchResponse,
            requestTimeoutMs,
            statusResponse,
          );
        if (path === "sandbox/wait")
          throw new SmokeFailure("invalid_response", response.status, {
            body: "unparseable",
            httpStatus: response.status,
          });
        throw new SmokeFailure("invalid_response", response.status, undefined, launchResponse);
      }
      const id = result?.sandbox?.id;
      if (requireSandboxUuid && (typeof id !== "string" || !SANDBOX_ID.test(id)))
        throw new SmokeFailure("invalid_response", response.status, undefined, launchResponse);
      const input = body as { provider?: string; externalRef?: string };
      if (
        sandboxLaunch &&
        input.provider === "docker" &&
        (result?.sandbox?.provider !== "docker" || result.sandbox.externalRef !== input.externalRef)
      )
        throw new SmokeFailure("invalid_response", response.status, undefined, launchResponse);
      // Keep the trusted handle even when other receipt fields fail validation.
      record(result);
      if (sandboxLaunch) {
        const provider = smokeReceiptProvider(result);
        if (provider === "boat") fail("invalid_response");
        const admission = receipt && input.provider && parseLaunchAdmissionReceipt(input.provider, result);
        if (!admission && provider !== input.provider)
          throw new SmokeFailure("invalid_response", response.status, undefined, launchResponse);
        if (typeof result?.sandbox?.id !== "string" || !result.sandbox.id)
          throw new SmokeFailure("invalid_response", response.status, undefined, launchResponse);
      }
      if (
        path === "templates/launch" &&
        (result?.state === "succeeded" || (typeof result?.id === "string" && result.id)) &&
        smokeReceiptProvider(result) !== "modal"
      )
        fail("invalid_response");
      return result as T;
    } catch (error) {
      if (error instanceof VaultSmokeFailure) throw error;
      const failure =
        error instanceof SmokeFailure
          ? error
          : new SmokeFailure(
              "request_failed",
              undefined,
              undefined,
              undefined,
              timedOut(error) ? requestTimeoutMs : undefined,
            );
      if (path === "creds/list") {
        const requestId = receivedResponse?.headers.get("x-request-id");
        throw new CredentialListSmokeFailure(failure, {
          phase: receivedResponse ? "body" : "headers",
          ...(receivedResponse ? { httpStatus: receivedResponse.status } : {}),
          ...(requestId && SANDBOX_ID.test(requestId) ? { requestId } : {}),
          ...(failure.transportTimeoutMs === undefined ? {} : { timeoutMs: failure.transportTimeoutMs }),
        });
      }
      throw failure;
    }
  }
  type PollRead<T> = (timeoutMs?: number, requestDeadline?: number) => Promise<T>;
  type PollOptions = { limit?: number; step?: string; until?: number; minRequestMs?: number };
  async function poll<T>(
    read: PollRead<T>,
    done: (value: T) => boolean,
    options: Omit<PollOptions, "step"> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const until = options.until ?? (timeoutMs === undefined ? undefined : Math.min(deadline, io.now() + timeoutMs));
    const limit = options.limit ?? (until === undefined ? POLLS : Number.POSITIVE_INFINITY);
    const requestDeadline = until ?? (options.minRequestMs === undefined ? undefined : deadline);
    const minRequestMs = options.minRequestMs ?? 1;
    for (let i = 0; i < limit; i++) {
      const remaining = requestDeadline === undefined ? undefined : requestDeadline - io.now();
      if (remaining !== undefined && remaining < minRequestMs) break;
      const value = await read(until === undefined ? undefined : remaining, requestDeadline).catch((error: unknown) => {
        if (
          error instanceof SmokeFailure &&
          error.code === "request_failed" &&
          error.transportTimeoutMs !== undefined &&
          until !== undefined &&
          io.now() >= until
        )
          throw new SmokeFailure(
            "poll_limit_exceeded",
            undefined,
            undefined,
            undefined,
            error.transportTimeoutMs,
            error.statusResponse,
          );
        throw error;
      });
      const after = requestDeadline === undefined ? Number.POSITIVE_INFINITY : requestDeadline - io.now();
      if (after >= 0 && done(value)) return value;
      if (after <= 0 || (options.minRequestMs !== undefined && after < SMOKE_POLL_INTERVAL_MS + minRequestMs)) break;
      if (i + 1 < limit) await io.sleep(Math.min(SMOKE_POLL_INTERVAL_MS, after));
    }
    fail("poll_limit_exceeded");
  }
  const defaultPins = new Map<number, string[]>();
  if (defaultSkills) {
    for (const [index, item] of cases.entries()) {
      const { request, withStepDeadline } = createLane(item.provider, "default-skills");
      try {
        const pins = await readDefaultPins(item.org, item.goldenId!, {
          request,
          step: (name, action) =>
            timedSmokeStep(
              () => withStepDeadline(name, action),
              io.now,
              (elapsedMs, error) => report(index, name, error, elapsedMs, "default-skills", item.provider),
            ),
        });
        defaultPins.set(index, pins);
        report(index, "default_skills_policy");
      } catch (error) {
        report(index, "default_skills_policy", error);
        return false;
      }
    }
  }
  // Vault allocates no compute and registers the canaries every later response is checked
  // against, so it completes before any sandbox unit starts.
  let vaultPassed = true;
  if (vault) {
    for (const [index, item] of cases.entries()) {
      const { request, withCleanup, withStepDeadline } = createLane(item.provider, "vault");
      const ok = await runVaultCase(item.org, {
        request,
        protect: (value) => protectedCanaries.add(value),
        isFailure: (error, status, code) =>
          error instanceof SmokeFailure && error.status === status && error.code === code,
        step: (name, action) =>
          timedSmokeStep(
            () => withStepDeadline(name, action),
            io.now,
            (elapsedMs, error) => report(index, name, error, elapsedMs, "vault", item.provider),
          ),
        out: (line) => io.out(JSON.stringify({ ...JSON.parse(line), case: index })),
        withCleanup,
      });
      if (!ok) vaultPassed = false;
    }
    if (args.every((arg) => arg === "--vault")) return vaultPassed;
  }
  /** One concurrent sandbox unit; every receipt carries its case and lane so interleaved output stays attributable. */
  function unit(index: number, provider: RealModelCase["provider"], lane: Lane) {
    const out = (line: string) => io.out(JSON.stringify({ ...JSON.parse(line), case: index, lane }));
    return {
      ...createLane(provider, lane),
      out,
      step: <T>(name: string, action: () => Promise<T>): Promise<T> =>
        timedSmokeStep(action, io.now, (elapsedMs, error) => report(index, name, error, elapsedMs, lane, provider)),
      io: { ...io, out } satisfies SmokeIo,
    };
  }
  function stopObserved(result: { status: string; providerState?: string | null }) {
    if (result.status !== "stopped" && result.status !== "failed") return false;
    if (result.status === "failed" && result.providerState == null) return false;
    if (result.providerState !== "stopped") fail("provider_not_stopped");
    return true;
  }
  function templateUnit(index: number, item: SmokeCase): Promise<boolean> {
    const { request, withCleanup, withStepDeadline, out, step, budgets, poll } = unit(
      index,
      item.provider,
      "templates",
    );
    return runTemplateSkillCase(
      { ...item, goldenId: item.goldenId! },
      {
        request: (path, body, timeout) => request(path, body, undefined, timeout),
        now: io.now,
        sleep: io.sleep,
        deadline,
        launchTimeout: (name) => budgets[name] ?? TEMPLATE_LAUNCH_TIMEOUT_MS,
        trackLaunch: (action) =>
          launches.track("templates/launch", (record) =>
            action(
              (body, timeout) => transport(false, "templates/launch", body, undefined, timeout, record),
              (id) => record({ id }),
            ),
          ),
        recordSandbox: (id, key) => io.recordSandbox?.(item.org, id, key, item.provider) ?? Promise.resolve(),
        isAmbiguousLaunch: (error) =>
          error instanceof SmokeFailure &&
          (["outcome_unknown", "request_failed", "invalid_response"].includes(error.code) ||
            (error.status ?? 0) >= 500),
        poll,
        step,
        measuredStep: (name, action) => step(name, () => withStepDeadline(name, action)),
        out,
        withCleanup,
        stopSandbox: async (id) => {
          try {
            const receipt = await request<{ id: string; status: string }>("sandbox/stop", { org: item.org, id });
            if (confirmsCleanupStop(receipt, id)) return;
          } catch (error) {
            if (!(error instanceof SmokeFailure) || error.code !== "outcome_unknown") throw error;
          }
          await poll(
            () => request<{ status: string; providerState: string }>("sandbox/status", { org: item.org, id }),
            stopObserved,
          );
        },
      },
    );
  }
  function launchWithObservation<T>(
    item: RealModelCase,
    body: object,
    timeoutMs: number,
    request: ReturnType<typeof createLane>["request"],
    keepHandle: (id: string) => void,
    options?: {
      receipt?: "admission";
      recover?: (id: string, requestKey: string, until: number) => Promise<T | undefined>;
    },
  ) {
    const path = "sandbox/launch";
    const recover = options?.recover;
    const requestKey = `post-deploy-smoke:${crypto.randomUUID()}`;
    const launch = smokeLaunch[item.provider];
    return launches.track(path, async (record) => {
      const launchBody = {
        ...body,
        org: item.org,
        idempotencyKey: requestKey,
        externalRef: requestKey,
      };
      try {
        return {
          result: await transport<T>(
            false,
            path,
            launchBody,
            undefined,
            timeoutMs,
            record,
            true,
            undefined,
            options?.receipt,
          ),
          recovered: false,
        };
      } catch (error) {
        if (!(error instanceof SmokeFailure)) throw error;
        const lostReceipt = error.code === "invalid_response" && error.launchResponse !== undefined;
        if (lostReceipt || ["outcome_unknown", "request_failed"].includes(error.code) || (error.status ?? 0) >= 500) {
          let observedId: string | undefined;
          const until = Math.min(deadline, io.now() + timeoutMs);
          const recovered = await observeSmokeLaunch(until, io, async (remaining) => {
            const result = await request<{
              sandboxes: { id: string; provider: string; externalRef: string; status: string }[];
            }>(
              "sandbox/list",
              { org: launchBody.org, owner: "me", externalRef: requestKey },
              undefined,
              Math.min(5_000, remaining),
            ).catch((readError: unknown) => {
              if (readError instanceof SmokeFailure) return undefined;
              throw readError;
            });
            const rows = result?.sandboxes;
            const row = rows?.[0];
            if (
              rows?.length === 1 &&
              typeof row?.id === "string" &&
              SANDBOX_ID.test(row.id) &&
              row.provider === item.provider &&
              row.externalRef === requestKey
            ) {
              if (observedId === undefined) {
                observedId = row.id;
                keepHandle(row.id);
                record({ sandbox: row });
                await io.recordSandbox?.(launchBody.org, row.id, requestKey, item.provider);
              }
              if (row.id !== observedId || !launch.ready.includes(row.status)) return;
              if (!recover) return { sandbox: row } as T;
              return recover(row.id, requestKey, until).catch((readError: unknown) => {
                if (readError instanceof SmokeFailure && readError.code === "modal_launch_setup_failed")
                  throw readError;
                if (readError instanceof SmokeFailure || readError instanceof TemplateSkillSmokeFailure)
                  return undefined;
                throw readError;
              });
            }
          });
          if (recovered !== undefined) return { result: recovered, recovered: true, recoveryUntil: until };
        }
        throw new SmokeFailure(error.code, error.status, undefined, {
          timeoutMs,
          ...error.launchResponse,
          requestKey,
        });
      }
    });
  }
  function expiryUnit(index: number, item: SmokeCase): Promise<boolean> {
    const { request, withCleanup, out, step, budgets } = unit(index, item.provider, "expiry");
    const timeoutMs = budgets.expiry_launch ?? 120_000;
    // A ready sandbox with no task no longer counts against its model account, so the expiry
    // lane gives the account back before its TTL wait, which then overlaps the other lanes.
    return accountSlot(item.modelAccountId.toLowerCase(), (release) =>
      runExpiryCase(item, {
        launch: async <T>(body: object, keepHandle: (id: string) => void) => {
          const { result } = await launchWithObservation<T>(item, body, timeoutMs, request, keepHandle, {
            receipt: "admission",
          });
          return result;
        },
        request: (path, body, remaining = 120_000) => request(path, body, undefined, Math.min(120_000, remaining)),
        deadlineFor: (name) => {
          const budget = budgets[name];
          return budget === undefined ? undefined : Math.min(deadline, io.now() + budget);
        },
        now: io.now,
        sleep: io.sleep,
        out,
        step,
        withCleanup,
        idle: release,
      }),
    );
  }
  // Every probe owns its sandbox, so the per-case lanes run concurrently: the expiry TTL
  // wait overlaps the lifecycle work instead of adding to it, subject to the account turns
  // below. Each
  // lane keeps its own receipts, failure report and cleanup; the run passes only if all do.
  // A model account admits a bounded number of working agents (possibly one), and every launch
  // reserves a slot before its fork: units that occupy the same account take turns across
  // lanes, in creation order, so no lane is refused with a conflict caused by its sibling.
  // Distinct accounts stay concurrent. Per account the order is templates, then expiry, then
  // lifecycle: expiry holds its account only until its sandbox is ready, so queueing it right
  // before the lifecycle runs makes its TTL wait overlap them. Queued ahead of a template probe
  // (up to a 10-minute launch), the sandbox could expire before any lifecycle work started.
  const accountSlot = createKeyedQueue();
  const modelUnits = realModelCases.map(({ item, source }, index) =>
    accountSlot(item.modelAccountId.toLowerCase(), () => realModelUnit(index, item, source)),
  );
  if (realModel && args.length === 1) return settled(modelUnits);
  const templateUnits = templatesSkills
    ? cases.map((item, index) => accountSlot(item.modelAccountId.toLowerCase(), () => templateUnit(index, item)))
    : [];
  const expiryUnits = expiry ? cases.map((item, index) => expiryUnit(index, item)) : [];
  if (expiry && args.length === 1) return settled(expiryUnits);
  // This mode is independently runnable; combined staging runs keep the existing
  // preservation baseline as well, under the same shared deadline.
  if (templatesSkills && !preservation && !lifecycle) return (await settled(templateUnits)) && vaultPassed;
  // A case's clean lifecycle and its preservation (dirty) run stay ordered in one lane:
  // they share the case's step names, and the expiry lane bounds the run anyway.
  // A scoped probe diffs the owner's inventory for its golden from before launch to after
  // cleanup. A scoped child is registered under its parent's owner and golden but is not an
  // owner API launch, so the launch tracker cannot attribute another case's child: probe
  // windows that share an org and golden run one after another. Other lanes stay concurrent.
  const scopedWindow = createKeyedQueue();
  const scopedUnits = scopedAccess
    ? cases.map(async (item, index) => {
        if (item.harness !== "codex") {
          io.out(JSON.stringify({ case: index, step: "scoped_access", skip: true, reason: "codex_only" }));
          return true;
        }
        const { reasoningEffort: _baselineEffort, ...scriptedCase } = item;
        const scripted = {
          ...scriptedCase,
          modelAccountId: item.scriptedModelAccountId!.toLowerCase(),
          model: "scripted",
        };
        const lane = unit(index, item.provider, "scoped");
        let passed = true;
        for (const mode of ["enabled", "no_option"] as const) {
          const ok = await scopedWindow(`${item.org}\n${item.goldenId}`, () =>
            accountSlot(scripted.modelAccountId, () => lifecycleUnit(index, scripted, false, lane, mode)),
          );
          if (!ok) passed = false;
        }
        return passed;
      })
    : [];
  const lifecycleUnits = cases.map(async (item, index) => {
    const lane = unit(index, item.provider, github ? "github-runtime" : "lifecycle");
    let passed = true;
    for (const dirty of preservation ? [false, true] : [false]) {
      if (!(await accountSlot(item.modelAccountId.toLowerCase(), () => lifecycleUnit(index, item, dirty, lane))))
        passed = false;
    }
    return passed;
  });
  return (
    (await settled([...modelUnits, ...templateUnits, ...expiryUnits, ...scopedUnits, ...lifecycleUnits])) && vaultPassed
  );
  async function realModelUnit(index: number, item: RealModelCase, source: RealModelLaunchSource) {
    const { request, withCleanup, withStepDeadline, step, out, budgets, poll } = unit(
      index,
      item.provider,
      "real-model",
    );
    const isAuthRefusal = (reason?: string) =>
      typeof reason === "string" &&
      (reason.startsWith("Authentication failed. ") ||
        promptFailureReason(reason) === promptFailureReason("authentication_failed") ||
        describeNativeFailure(reason)?.title === "Authentication failed");
    let id: string | undefined;
    let passed = false;
    let waitForSetup = false;
    const sandbox = <T>(action: string, body: object = {}, timeoutMs?: number) =>
      request<T>(`sandbox/${action}`, { org: item.org, id, ...body }, undefined, timeoutMs);
    const status = (timeoutMs?: number) =>
      sandbox<{
        status: string;
        providerState?: string;
        statusReason?: string;
        settled?: boolean;
        statusMessage?: string | null;
      }>("status", {}, timeoutMs);
    out(JSON.stringify({ step: "real_model", model: "real", provider: item.provider }));
    try {
      await step("real_model_launch", async () => {
        const { result, recovered } = await launchWithObservation<{ sandbox: { id: string; status?: string } }>(
          item,
          {
            provider: item.provider,
            harness: "codex",
            model: item.model,
            credentialId: item.modelAccountId,
            visibility: "private",
            ttlSeconds: 1800,
            ...source,
          },
          budgets.real_model_launch ?? TEMPLATE_LAUNCH_TIMEOUT_MS,
          request,
          (handle) => {
            id = handle;
          },
          { receipt: "admission" },
        ).catch(refuseModelCredentials);
        id = result.sandbox.id;
        waitForSetup =
          !!parseLaunchAdmissionReceipt(item.provider, result) ||
          (recovered && smokeLaunch[item.provider].waitForRecoveredSetup);
      });
      await step("real_model_ready", () =>
        poll(
          status,
          (result) => {
            if (isAuthRefusal(result.statusReason)) fail("model_authentication_refused");
            if (["failed", "stopped", "deleted"].includes(result.status)) fail("sandbox_not_ready");
            if (!smokeLaunch[item.provider].ready.includes(result.status)) return false;
            if (!waitForSetup) return true;
            if (modalSmokeSetupFailed(result)) fail("modal_launch_setup_failed");
            if (result.settled !== true) return false;
            if (result.statusMessage !== null) fail("invalid_response");
            return true;
          },
          { step: "real_model_ready" },
        ),
      );
      const turn = await step("real_model_send", () =>
        withStepDeadline("real_model_send", async () => {
          const result = await sandbox<{ promptId: string }>("send", {
            prompt: "Say hello in a short sentence. Do not use tools.",
            request_id: crypto.randomUUID(),
          }).catch(refuseModelCredentials);
          if (typeof result?.promptId !== "string" || !result.promptId) fail("invalid_response");
          return result;
        }),
      );
      await step("real_model_wait", async () => {
        const until = Math.min(deadline, io.now() + (budgets.real_model_wait ?? POLLS * SMOKE_POLL_INTERVAL_MS));
        let finished = false;
        await poll(
          async (timeoutMs) => {
            const started = io.now();
            if (!finished) {
              const { prompt } = await sandbox<{ prompt?: { promptId: string; state: string; reason?: string } }>(
                "wait",
                { prompt_id: turn.promptId, timeout_seconds: 0 },
                timeoutMs,
              ).catch(refuseModelCredentials);
              if (prompt?.promptId !== turn.promptId) return false;
              if (prompt.state === "failed" && isAuthRefusal(prompt.reason)) fail("model_authentication_refused");
              if (["failed", "interrupted"].includes(prompt.state)) fail("turn_failed");
              finished = prompt.state === "finished";
              if (!finished) return false;
            }
            const remaining = timeoutMs === undefined ? undefined : timeoutMs - (io.now() - started);
            if (remaining !== undefined && remaining <= 0) return false;
            const page = await request<{
              events: {
                kind: string;
                promptId?: string;
                partial?: boolean;
                text?: string;
                parentToolUseId?: string;
                responseKind?: string;
                retracted?: boolean;
              }[];
            }>("logs/read", { org: item.org, id, all: true, coalesce: true }, undefined, remaining);
            return page.events.some(
              (event) =>
                event.kind === "message" &&
                event.promptId === turn.promptId &&
                event.partial === false &&
                !event.parentToolUseId &&
                event.responseKind !== "tool_result" &&
                !event.retracted &&
                typeof event.text === "string" &&
                event.text.trim().length > 0,
            );
          },
          Boolean,
          { until },
        ).catch((error: unknown) => {
          if (
            error instanceof SmokeFailure &&
            (error.code === "poll_limit_exceeded" || (error.code === "request_failed" && io.now() >= until))
          )
            fail(finished ? "invalid_receipt" : "model_timeout");
          throw error;
        });
      });
      passed = true;
    } catch {
      passed = false;
    } finally {
      if (id) {
        try {
          await withCleanup(() =>
            step("real_model_stop", () =>
              withStepDeadline(
                "real_model_stop",
                async (until) => {
                  try {
                    const receipt = await sandbox<{ id: string; status: string }>("stop", {
                      request_id: crypto.randomUUID(),
                    });
                    if (confirmsCleanupStop(receipt, id!)) return;
                  } catch (error) {
                    if (!(error instanceof SmokeFailure) || error.code !== "outcome_unknown") throw error;
                  }
                  await poll(status, stopObserved, until === undefined ? undefined : { until });
                },
                { measureCleanup: true },
              ),
            ),
          );
        } catch {
          passed = false;
        }
      }
    }
    return passed;
  }
  function refuseModelCredentials(error: unknown): never {
    if (error instanceof SmokeFailure && error.code === "credential_refused") fail("model_authentication_refused");
    throw error;
  }

  async function lifecycleUnit(
    index: number,
    item: SmokeCase,
    dirty: boolean,
    { request, withCleanup, withStepDeadline, step, io, budgets, poll }: ReturnType<typeof unit>,
    scope?: "enabled" | "no_option",
  ): Promise<boolean> {
    let passed = true;
    const sandbox = <T>(action: string, body: object, timeoutMs?: number) =>
      request<T>(`sandbox/${action}`, { org: item.org, ...body }, undefined, timeoutMs);
    const measuredStep = <T>(name: string, action: (until?: number) => Promise<T>) =>
      step(name, () => withStepDeadline(name, action));
    let parentCredentialVersion: number | undefined;
    const scoped = scope
      ? createScopedProbe({ ...item, goldenId: item.goldenId! }, scope === "enabled", {
          request: (path, body, timeoutMs) => request(path, { ...body, org: item.org }, undefined, timeoutMs),
          now: io.now,
          sleep: io.sleep,
          deadline,
          stepTimeouts: budgets,
          recordSandbox: (id, key) => io.recordSandbox?.(item.org, id, key, item.provider) ?? Promise.resolve(),
          poll: (read, done, until) => poll(read, done, until === undefined ? { limit: 300 } : { until }),
          step,
          withCleanup,
          siblingSandboxes: (candidates) => {
            const until = io.now() + SIBLING_ATTRIBUTION_WAIT_MS;
            return launches.siblings(
              candidates,
              () => io.now() >= until,
              () => io.sleep(1_000),
            );
          },
          siblingLaunchLost: launches.lostLaunch,
          isNotReady: (error) => error instanceof SmokeFailure && error.code === "sandbox_not_ready",
          out: (line) => io.out(JSON.stringify({ ...JSON.parse(line), case: index })),
          stopSandbox: async (id) => {
            try {
              const receipt = await sandbox<{ id: string; status: string }>("stop", { id });
              if (confirmsCleanupStop(receipt, id)) return;
            } catch (error) {
              if (!(error instanceof SmokeFailure) || !["outcome_unknown", "request_failed"].includes(error.code))
                throw error;
            }
            await poll(
              () => sandbox<{ id: string; status: string; providerState: string }>("status", { id }),
              (status) =>
                status.id === id && ["stopped", "failed"].includes(status.status) && status.providerState === "stopped",
            );
          },
        })
      : undefined;
    const scratch = `armada-runtime-smoke-${crypto.randomUUID()}`;
    const receipt = `/tmp/${scratch}`;
    let pushAttempted = false;
    const git = `git -C ${quote(item.repo)}`;
    const remoteGuard = `test "$(${git} remote get-url origin)" = ${quote(item.disposableRepository ?? "")}`;
    async function checkedExec(command: string) {
      const result = await sandbox<{ exitCode: number | null; timedOut: boolean }>("exec", {
        id: sandboxId,
        command,
        cwd: item.repo,
        timeout_seconds: 60,
      });
      if (result?.exitCode !== 0 || result.timedOut !== false) fail("exec_failed");
    }
    if (github)
      io.out(
        JSON.stringify({
          case: index,
          step: "github_runtime_metadata",
          provider: item.provider,
          harness: item.harness,
          gate: true,
          serverRevision: env.ARMADA_SMOKE_SERVER_REVISION,
          runtimeRevision: env.ARMADA_SMOKE_RUNTIME_REVISION,
          revisionSource: "operator_asserted",
          scratchBranch: scratch,
        }),
      );
    const startedAt = io.now();
    let launchAttempted = false;
    let verifiedRecoveryId: string | undefined;
    let launchSkills: unknown;
    let hasAdmissionReceipt = false;
    let launchSetupUntil: number | undefined;
    let sandboxId: string | undefined;
    let commit: string | undefined;
    const preservationMarker = crypto.randomUUID();
    let stopped = false;
    let stopRequested = false;
    let preservationNote: string | undefined;
    async function stopSandbox(until?: number, observe = true) {
      let receipt: { id: string; status: string; preservationNote?: string } | null = null;
      if (!stopRequested) {
        try {
          receipt = await sandbox<{ id: string; status: string; preservationNote?: string }>("stop", {
            id: sandboxId,
          });
          preservationNote = receipt?.preservationNote;
        } catch (error) {
          // The stop may already be in flight. Observe it; never replay an unknown mutation.
          if (
            !(error instanceof SmokeFailure) ||
            (error.code !== "outcome_unknown" && error.transportTimeoutMs === undefined)
          )
            throw error;
        }
        stopRequested = true;
      }
      let stopWarning = preservationNote?.includes("checkpoint_failed_disk_not_retained");
      if (observe || !confirmsCleanupStop(receipt, sandboxId!)) {
        const status = await poll(
          () =>
            sandbox<{ status: string; providerState: string; preservationNote?: string }>("status", { id: sandboxId }),
          stopObserved,
          until === undefined ? undefined : { until },
        );
        stopWarning ||= status.preservationNote?.includes("checkpoint_failed_disk_not_retained");
        preservationNote = status.preservationNote ?? preservationNote;
      }
      if (stopWarning)
        io.out(JSON.stringify({ case: index, step: "stop_warning", warning: "checkpoint_failed_disk_not_retained" }));
      stopped = true;
    }
    type LaunchReceipt = {
      sandbox: {
        id: string;
        provider?: string;
        skills?: unknown;
        harness?: string;
        model?: string;
        reasoningEffort?: string;
        credentialId?: string;
        credentialVersion?: number;
        visibility?: string;
      };
      armadaAccess?: { enabled?: boolean; maxActiveChildren?: number };
      golden?: { id: string };
      promptId?: string;
    };
    const matchesParentConfiguration = (parent: LaunchReceipt["sandbox"]) =>
      parent.harness === item.harness &&
      parent.model === item.model &&
      (!item.reasoningEffort || parent.reasoningEffort === item.reasoningEffort) &&
      parent.credentialId === item.modelAccountId &&
      typeof parent.credentialVersion === "number" &&
      Number.isSafeInteger(parent.credentialVersion) &&
      parent.credentialVersion >= 1 &&
      (scope !== "enabled" || parent.visibility === "private");
    async function run() {
      if (scoped) {
        io.out(JSON.stringify({ step: "scoped_access", mode: scope, model: "scripted" }));
        await scoped.prepare();
      }
      const launchStep = scoped ? "scoped_parent_launch" : "launch";
      const launchBudget = budgets[launchStep] ?? 600_000;
      await step(launchStep, async () => {
        launchAttempted = true;
        const body = {
          ...(scope === "enabled" ? { armadaAccessVersion: 1, armadaAccess: { maxActiveChildren: 1 } } : {}),
          golden: item.golden,
          provider: item.provider,
          harness: item.harness,
          model: item.model,
          credentialId: item.modelAccountId,
          ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
          connections: [],
          ...((defaultSkills && dirty) || scope === "no_option" ? { skipSkillDefaults: true } : {}),
          ttlSeconds: 1800,
        };
        const requiresLaunchReceipt = defaultSkills || scope !== undefined;
        const acceptsAdmission = scope !== undefined || lifecycle || preservation || goldenRuntime;
        const recoverLaunch = requiresLaunchReceipt
          ? async (id: string, requestKey: string, until: number) => {
              const inventoryRemaining = until - io.now();
              if (inventoryRemaining <= 0) return;
              const goldenId = item.goldenId!;
              const inventory = await sandbox<{ sandboxes: { id: string; externalRef: string }[] }>(
                "list",
                { owner: "me", externalRef: requestKey, golden: goldenId },
                Math.min(5_000, inventoryRemaining),
              );
              if (
                inventory?.sandboxes?.length !== 1 ||
                inventory.sandboxes[0]?.id !== id ||
                inventory.sandboxes[0].externalRef !== requestKey
              )
                return;
              const remaining = until - io.now();
              if (remaining <= 0) return;
              const status = await sandbox<
                LaunchReceipt["sandbox"] & {
                  externalRef?: string;
                  status: string;
                  prompt: unknown;
                  settled: boolean;
                  statusMessage: string | null;
                }
              >("status", { id }, Math.min(5_000, remaining));
              if (status?.id !== id || status.externalRef !== requestKey) return;
              if (modalSmokeSetupFailed(status)) fail("modal_launch_setup_failed");
              if (status.status !== "ready" || status.prompt !== null) return;
              if (
                scope &&
                (!matchesParentConfiguration(status) || status.settled !== true || status.statusMessage !== null)
              )
                return;
              if (defaultSkills && !scope) {
                if (status.settled !== true || status.statusMessage !== null) return;
                verifyReceipts(status.skills, dirty ? [] : defaultPins.get(index)!);
              }
              return { sandbox: status, golden: { id: goldenId } };
            }
          : undefined;
        const { result, recovered, recoveryUntil } = await launchWithObservation<LaunchReceipt>(
          item,
          body,
          launchBudget,
          request,
          (id) => {
            sandboxId = id;
          },
          {
            ...(recoverLaunch ? { recover: recoverLaunch } : {}),
            ...(acceptsAdmission ? { receipt: "admission" } : {}),
          },
        );
        const parent = result?.sandbox;
        // Retain the cleanup handle even if later response validation fails.
        if (typeof parent?.id === "string" && parent.id) sandboxId = parent.id;
        if (!sandboxId || result.promptId) fail("invalid_response");
        hasAdmissionReceipt = acceptsAdmission && !!parseLaunchAdmissionReceipt(item.provider, result);
        if (
          !scoped &&
          !defaultSkills &&
          (hasAdmissionReceipt || (recovered && smokeLaunch[item.provider].waitForRecoveredSetup))
        )
          launchSetupUntil = recoveryUntil ?? Math.min(deadline, io.now() + launchBudget);
        if (!recovered && parent?.provider !== item.provider && !hasAdmissionReceipt) fail("invalid_response");
        if (requiresLaunchReceipt && !hasAdmissionReceipt && result.golden?.id !== item.goldenId)
          fail("invalid_response");
        if (scope && !hasAdmissionReceipt)
          await step("scoped_parent_configuration", async () => {
            if (!matchesParentConfiguration(parent)) fail("invalid_response");
            if (
              !recovered &&
              (scope === "no_option"
                ? result.armadaAccess?.enabled === true
                : result.armadaAccess?.enabled !== true || result.armadaAccess.maxActiveChildren !== 1)
            )
              fail("invalid_response");
            parentCredentialVersion = parent.credentialVersion;
          });
        launchSkills = parent.skills;
      });
      const readinessStep = scoped ? "scoped_parent_ready" : "ready";
      const scopedAdmissionUntil =
        scoped && hasAdmissionReceipt ? Math.min(deadline, io.now() + launchBudget) : undefined;
      const readinessUntil = scopedAdmissionUntil ?? launchSetupUntil;
      await step(readinessStep, async () => {
        let statusResponse: { status: string; providerState: string; statusReason: string } | undefined;
        try {
          await poll(
            async (timeoutMs) => {
              const result = await sandbox<{
                status?: unknown;
                providerState?: unknown;
                statusReason?: unknown;
              } | null>("status", { id: sandboxId }, timeoutMs);
              const { status, providerState, statusReason } = result ?? {};
              statusResponse = {
                status:
                  typeof status === "string" && OBSERVED_SANDBOX_STATUSES.includes(status) ? status : jsonShape(status),
                providerState:
                  providerState === "active" || providerState === "stopped" ? providerState : jsonShape(providerState),
                statusReason: jsonShape(statusReason),
              };
              return result;
            },
            (result) => {
              if (result === null) fail("invalid_response");
              const { status } = result;
              if (status === "failed" || status === "stopped") fail("sandbox_not_ready");
              return status === "ready";
            },
            readinessUntil === undefined ? { step: readinessStep } : { until: readinessUntil },
          );
        } catch (error) {
          if (error instanceof SmokeFailure) {
            io.out(
              JSON.stringify({
                step: "readiness_diagnostic",
                readinessStep,
                code: error.code,
                statusResponse,
                transportTimeoutMs: error.transportTimeoutMs,
                httpStatus: error.status,
              }),
            );
          }
          throw error;
        }
      });
      if (scoped) {
        if (scopedAdmissionUntil !== undefined)
          await step("scoped_parent_configuration", async () => {
            const remaining = () => scopedAdmissionUntil - io.now();
            await consistent("ready", item.goldenId, remaining);
            const read = (timeoutMs?: number) =>
              sandbox<
                LaunchReceipt["sandbox"] & {
                  status: string;
                  prompt: unknown;
                  settled: boolean;
                  statusMessage: string | null;
                }
              >("status", { id: sandboxId }, timeoutMs);
            const settled = await poll(read, (status) => status?.settled === true, { until: scopedAdmissionUntil });
            if (modalSmokeSetupFailed(settled)) fail("modal_launch_setup_failed");
            if (settled.statusMessage !== null) fail("invalid_response");
            const parent = await read(remaining());
            if (remaining() < 0) fail("poll_limit_exceeded");
            if (
              parent?.id !== sandboxId ||
              parent.status !== "ready" ||
              parent.prompt !== null ||
              parent.settled !== true ||
              parent.statusMessage !== null ||
              !matchesParentConfiguration(parent)
            )
              fail("invalid_response");
            parentCredentialVersion = parent.credentialVersion;
          });
        await scoped.run(sandboxId!, parentCredentialVersion!);
        await measuredStep("scoped_parent_stop", stopSandbox);
        return;
      }
      if (lifecycle && !dirty)
        io.out(
          JSON.stringify({
            case: index,
            step: "time_to_ready",
            pass: true,
            provider: item.provider,
            harness: item.harness,
            elapsedMs: io.now() - startedAt,
          }),
        );
      const setupUntil = launchSetupUntil;
      if (setupUntil !== undefined) {
        await step("list_ready", () => consistent("ready", undefined, () => setupUntil - io.now()));
        await step("launch_setup", async () => {
          await poll(
            (timeoutMs) =>
              sandbox<{
                id: string;
                status: string;
                prompt: unknown;
                settled: boolean;
                statusMessage: string | null;
              }>("status", { id: sandboxId }, timeoutMs),
            (status) => {
              if (status?.id !== sandboxId || status.status !== "ready" || status.prompt !== null)
                fail("invalid_response");
              if (status.settled !== true) return false;
              if (modalSmokeSetupFailed(status)) fail("modal_launch_setup_failed");
              if (status.statusMessage !== null) fail("invalid_response");
              return true;
            },
            { until: setupUntil },
          );
        });
      } else if (hasAdmissionReceipt) {
        await measuredStep("list_ready", () => consistent("ready", defaultSkills ? item.goldenId : undefined));
      }
      if (defaultSkills) {
        const expected = defaultPins.get(index)!;
        const receiptStep = dirty ? "default_skills_opt_out_receipts" : "default_skills_receipts";
        await step(receiptStep, () =>
          withStepDeadline(receiptStep, async (until) => {
            const pins = dirty ? [] : expected;
            if (!hasAdmissionReceipt) {
              const status = await sandbox<{ skills?: unknown }>("status", { id: sandboxId });
              verifyDefaultReceipts(launchSkills, status.skills, pins);
              return;
            }

            const readSetupStatus = (timeoutMs?: number) =>
              sandbox<{
                id: string;
                status: string;
                prompt: unknown;
                settled: boolean;
                statusMessage: string | null;
                skills?: unknown;
              }>("status", { id: sandboxId }, timeoutMs);
            const settled = await poll(
              readSetupStatus,
              (status) => status?.settled === true,
              until === undefined ? {} : { until },
            );
            if (modalSmokeSetupFailed(settled)) fail("modal_launch_setup_failed");
            if (settled.statusMessage !== null) fail("invalid_response");

            const status = await readSetupStatus();
            if (
              status?.id !== sandboxId ||
              status.status !== "ready" ||
              status.prompt !== null ||
              status.settled !== true ||
              status.statusMessage !== null
            )
              fail("invalid_response");
            verifyReceipts(status.skills, pins);
          }),
        );
        if (!expected.length)
          io.out(
            JSON.stringify({
              case: index,
              step: dirty ? "default_skills_opt_out_delivery" : "default_skills_installation",
              skip: true,
              reason: "no_default_pins_configured",
            }),
          );
      }
      if (goldenRuntime && !dirty) {
        await measuredStep("golden_helper_integrity", () => checkedExec(helperProbe));
        await measuredStep("golden_skillpack_integrity", () => checkedExec(skillpackProbe));
      }
      if (githubRefresh && !dirty)
        await measuredStep("github_launch_access", () => checkedExec(`${git} ls-remote origin HEAD >/dev/null 2>&1`));
      async function consistent(expected: string, golden?: string, remaining?: () => number) {
        const status = await sandbox<{ id: string; harness: string; status: string; expiresAt: string | null }>(
          "status",
          { id: sandboxId },
          remaining?.(),
        );
        if (status.id !== sandboxId || status.harness !== item.harness || status.status !== expected)
          fail("list_status_mismatch");
        let page = 1;
        for (let attempt = 0; attempt < 20; attempt++) {
          const result = await sandbox<{
            sandboxes: { id: string; provider: string; harness: string; status: string; expiresAt: string | null }[];
            page: number;
            hasMore: boolean;
            nextPage: number | null;
          }>(
            "list",
            {
              owner: "me",
              harness: item.harness,
              status: [expected],
              ...(golden ? { golden } : {}),
              limit: 200,
              page,
            },
            remaining?.(),
          );
          if (!Array.isArray(result?.sandboxes) || result.page !== page || typeof result.hasMore !== "boolean")
            fail("invalid_response");
          const matches = result.sandboxes.filter((row) => row.id === sandboxId);
          if (matches.length) {
            const row = matches[0]!;
            if (
              matches.length !== 1 ||
              row.provider !== item.provider ||
              row.harness !== status.harness ||
              row.status !== status.status ||
              row.expiresAt !== status.expiresAt
            )
              fail("list_status_mismatch");
            return;
          }
          if (!result.hasMore) fail("list_status_mismatch");
          if (result.nextPage !== page + 1) fail("invalid_response");
          page++;
        }
        fail("poll_limit_exceeded");
      }
      async function nativeTurn(second: boolean, phase?: string) {
        const commands = `${git} status -sb >/dev/null 2>&1; a=$?; ${git} ls-remote origin HEAD >/dev/null 2>&1; b=$?; ${second ? "c=0" : `${git} push origin HEAD:refs/heads/${scratch} >/dev/null 2>&1; c=$?`}; printf '%s %s %s' "$a" "$b" "$c" > ${quote(receipt)}`;
        if (github) {
          await step("repository_guard", () => checkedExec(remoteGuard));
          await checkedExec(`rm -f ${quote(receipt)}`);
          if (!second) pushAttempted = true;
        }
        const sendStep = phase ? `${phase}_send` : second ? "send_second" : "send";
        const turn = await step(sendStep, async () => {
          const result = await poll(
            async (timeoutMs) => {
              try {
                return await sandbox<{ promptId: string }>(
                  "send",
                  {
                    id: sandboxId,
                    prompt: github
                      ? `Run exactly this shell command using your terminal tool, without reading credentials or making other changes: ${commands}`
                      : PROMPT,
                  },
                  timeoutMs,
                );
              } catch (error) {
                // Only this closed rejection guarantees the prompt was not admitted.
                if (!(error instanceof SmokeFailure) || error.code !== "sandbox_not_ready") throw error;
                return null;
              }
            },
            (result) => result !== null,
            { step: sendStep },
          );
          if (!result?.promptId || typeof result.promptId !== "string") fail("invalid_response");
          return result;
        });
        const waitStep = phase ? `${phase}_wait` : "wait";
        await step(waitStep, async () => {
          let lastResponse: SmokeFailure["waitResponse"];
          try {
            await poll(
              async (timeoutMs) => {
                const result = await sandbox<{
                  prompt?: { promptId?: unknown; state?: unknown } | null;
                  status?: unknown;
                  providerState?: unknown;
                  settled?: unknown;
                  timedOut?: unknown;
                } | null>("wait", { id: sandboxId, prompt_id: turn.promptId, timeout_seconds: 0 }, timeoutMs);
                const prompt = result?.prompt;
                const state = prompt?.state;
                const status = result?.status;
                // Use fixed field names and closed values. A malformed body may contain arbitrary secrets.
                lastResponse = {
                  body: jsonShape(result),
                  status:
                    typeof status === "string" && OBSERVED_SANDBOX_STATUSES.includes(status)
                      ? status
                      : jsonShape(status),
                  providerState: jsonShape(result?.providerState),
                  prompt: jsonShape(prompt),
                  promptId: jsonShape(prompt?.promptId),
                  promptIdMatches: prompt?.promptId === turn.promptId,
                  state:
                    state === "running" || state === "finished" || state === "failed" || state === "interrupted"
                      ? state
                      : jsonShape(state),
                  settled: typeof result?.settled === "boolean" ? result.settled : jsonShape(result?.settled),
                  timedOut: typeof result?.timedOut === "boolean" ? result.timedOut : jsonShape(result?.timedOut),
                };
                return lastResponse;
              },
              (response) => {
                const { state, promptIdMatches } = response;
                if (promptIdMatches) {
                  if (state === "failed" || state === "interrupted") fail("turn_failed");
                  if (state === "running" || state === "finished") return state === "finished";
                }
                throw new SmokeFailure("invalid_response", undefined, response);
              },
              { step: waitStep },
            );
          } catch (error) {
            if (
              error instanceof SmokeFailure &&
              (error.code === "poll_limit_exceeded" || error.transportTimeoutMs !== undefined)
            ) {
              throw new SmokeFailure(error.code, error.status, {
                ...lastResponse,
                ...(error.status === undefined ? {} : { httpStatus: error.status }),
                ...(error.transportTimeoutMs === undefined ? {} : { transportTimeoutMs: error.transportTimeoutMs }),
              });
            }
            throw error;
          }
        });
        const usageStep = phase ? `${phase}_usage` : second ? "usage_second" : "usage";
        await step(usageStep, async () => {
          let attempts = 0;
          let lastResponse: Record<string, string | boolean | number> | null = null;
          try {
            await poll(
              async (timeoutMs, requestDeadline) => {
                const startedAt = io.now();
                const result = await request<{
                  usage?: {
                    turns?: {
                      promptId: string;
                      inputTokens: number | null;
                      outputTokens: number | null;
                    }[];
                    tokenTotals?: { inputTokens: number | null; outputTokens: number | null; incomplete?: boolean };
                  };
                } | null>("sandbox/status", { org: item.org, id: sandboxId }, undefined, timeoutMs, {
                  deadline: requestDeadline ?? deadline,
                  onDispatch: () => {
                    attempts++;
                  },
                });
                const usage = result?.usage;
                const row = Array.isArray(usage?.turns)
                  ? usage.turns.find((row) => row?.promptId === turn.promptId)
                  : undefined;
                const totals = usage?.tokenTotals;
                // Journal only field shapes and booleans. Status bodies may contain secrets.
                lastResponse = {
                  elapsedMs: io.now() - startedAt,
                  turns: jsonShape(usage?.turns),
                  promptMatched: row !== undefined,
                  inputTokens: jsonShape(row?.inputTokens),
                  outputTokens: jsonShape(row?.outputTokens),
                  totalInputTokens: jsonShape(totals?.inputTokens),
                  totalOutputTokens: jsonShape(totals?.outputTokens),
                  incomplete:
                    typeof totals?.incomplete === "boolean" ? totals.incomplete : jsonShape(totals?.incomplete),
                };
                return (
                  totals?.incomplete !== true &&
                  typeof row?.inputTokens === "number" &&
                  typeof row.outputTokens === "number" &&
                  typeof totals?.inputTokens === "number" &&
                  typeof totals.outputTokens === "number"
                );
              },
              (accepted) => accepted,
              { step: usageStep, minRequestMs: USAGE_STATUS_MIN_REQUEST_MS },
            );
          } catch (error) {
            if (
              error instanceof SmokeFailure &&
              (error.code === "poll_limit_exceeded" ||
                error.code === "request_failed" ||
                error.transportTimeoutMs !== undefined)
            ) {
              io.out(
                JSON.stringify({
                  step: "usage_request_diagnostic",
                  usageStep,
                  provider: item.provider,
                  route: "sandbox/status",
                  timeoutMs: error.transportTimeoutMs ?? null,
                  code: error.code,
                  attempts,
                  lastResponse,
                  ...error.statusResponse,
                  ...(sandboxId && SANDBOX_ID.test(sandboxId) ? { sandboxId } : {}),
                  ...(SANDBOX_ID.test(turn.promptId) ? { promptId: turn.promptId } : {}),
                }),
              );
            }
            throw error;
          }
        });
        if (github)
          await step(second ? "native_git_second" : "native_git_first", async () => {
            const result = await sandbox<{ exitCode: number | null; timedOut: boolean; stdout?: unknown }>("exec", {
              id: sandboxId,
              command: `head -c 64 -- ${quote(receipt)}`,
              cwd: item.repo,
              timeout_seconds: 60,
            });
            if (
              result?.exitCode !== 0 ||
              result.timedOut !== false ||
              typeof result.stdout !== "string" ||
              !/^\d{1,3} \d{1,3} \d{1,3}$/.test(result.stdout)
            )
              fail("invalid_receipt");
            const [status, remote, push] = result.stdout.split(" ").map(Number);
            if ([status, remote, push].some((value) => value === undefined || value > 255)) fail("invalid_receipt");
            io.out(
              JSON.stringify({
                case: index,
                step: "native_git_exit_statuses",
                turn: second ? 2 : 1,
                status,
                remote,
                ...(second ? {} : { push }),
              }),
            );
            if (status !== 0 || remote !== 0 || push !== 0) fail("exec_failed");
          });
      }
      if (preservation)
        await measuredStep("preservation_clean_checkout", () =>
          checkedExec(
            `test -z "$(${git} status --porcelain)" && test -z "$(${git} rev-list HEAD --branches --tags --not --remotes)"`,
          ),
        );
      await nativeTurn(false);
      if (lifecycle && !dirty) {
        if (!hasAdmissionReceipt && setupUntil === undefined)
          await measuredStep("list_ready", () => consistent("ready"));
        await measuredStep("steer_refused", async () => {
          try {
            await sandbox("steer", { id: sandboxId, text: "Smoke: no turn should be running." });
          } catch (error) {
            if (error instanceof SmokeFailure && error.code === "no_running_turn" && error.status === 409) return;
            throw error;
          }
          fail("steer_not_refused");
        });
        await measuredStep("extend", async () => {
          const before = await sandbox<{ expiresAt: string }>("status", { id: sandboxId });
          const previous = Date.parse(before.expiresAt);
          if (!Number.isFinite(previous)) fail("invalid_response");
          // A modest extension fits Modal's existing launch headroom; no wall-clock wait.
          const extension = await sandbox<{ id: string; expiresAt: string; ttlSeconds: number }>("extend", {
            id: sandboxId,
            ttlSeconds: 1860,
          });
          if (
            extension.id !== sandboxId ||
            extension.ttlSeconds !== 1860 ||
            !Number.isFinite(Date.parse(extension.expiresAt)) ||
            Date.parse(extension.expiresAt) <= previous
          )
            fail("invalid_receipt");
          const after = await sandbox<{ expiresAt: string }>("status", { id: sandboxId });
          if (after.expiresAt !== extension.expiresAt) fail("list_status_mismatch");
        });
      }
      for (const [name, command] of [
        ["git_status", "git status -sb"],
        ["git_remote", "git ls-remote origin HEAD"],
      ] as const) {
        await measuredStep(name, async () => {
          const result = await sandbox<{ exitCode: number | null; timedOut: boolean }>("exec", {
            id: sandboxId,
            command,
            cwd: item.repo,
            timeout_seconds: 60,
          });
          if (github) {
            const exitCode = result?.exitCode;
            if (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255))
              fail("invalid_response");
            io.out(
              JSON.stringify({
                case: index,
                step: "exec_git_exit_status",
                operation: name,
                exitCode,
                timedOut: result.timedOut === true,
              }),
            );
          }
          if (result?.exitCode !== 0 || result.timedOut !== false) fail("exec_failed");
        });
      }
      if (githubRefresh && !dirty) {
        await measuredStep("github_refresh", async () => {
          const receipt = await request<{
            id: string;
            status: string;
            login: unknown;
            runtime?: { kind: string; epoch: unknown };
            revision?: unknown;
          }>("github/refresh", { org: item.org, id: sandboxId });
          if (
            receipt?.id !== sandboxId ||
            receipt.status !== "connected" ||
            typeof receipt.login !== "string" ||
            !receipt.login ||
            receipt.runtime?.kind !== "armada" ||
            typeof receipt.runtime.epoch !== "string" ||
            !/^[1-9][0-9]*$/.test(receipt.runtime.epoch) ||
            typeof receipt.revision !== "string" ||
            !/^[1-9][0-9]*$/.test(receipt.revision)
          )
            fail("invalid_receipt");
        });
      }
      if (github) {
        await nativeTurn(true);
        io.out(
          JSON.stringify({
            case: index,
            step: "enablement",
            complete: false,
            renewal: "manual_required",
            brokerFaults: "manual_required",
            nativeSessionIdentity: "not_verified",
            secondTurnFinished: true,
          }),
        );
      }
      if (preservation && dirty)
        await measuredStep("preservation_commit", async () => {
          const result = await sandbox<{ exitCode: number; timedOut: boolean; stdout: string }>("exec", {
            id: sandboxId,
            cwd: item.repo,
            command: `${git} -c user.name=Armada-Smoke -c user.email=smoke@example.invalid -c core.hooksPath=/dev/null -c commit.gpgsign=false commit --allow-empty -m ${quote(`armada-preservation-smoke-${preservationMarker}`)} >/dev/null && ${git} rev-parse HEAD`,
            timeout_seconds: 60,
          });
          if (result?.exitCode !== 0 || result.timedOut !== false || !/^[a-f0-9]{40}\n?$/.test(result.stdout))
            fail("invalid_receipt");
          commit = result.stdout.trim();
        });
      if (!github) await measuredStep("stop", (until) => stopSandbox(until, preservation || lifecycle));
      if (preservation) {
        // Recovery is a read-only operation, but do not reuse the earlier stop
        // receipt if verification fails or a regression wakes the worker.
        stopped = false;
        stopRequested = false;
        let verifiedArchive: string | undefined;
        const note = preservationNote;
        await measuredStep(dirty ? "preservation_archive" : "preservation_clean_stop", async () => {
          const result = await sandbox<{ archive: string | null }>("recovery", { id: sandboxId });
          if (!dirty) {
            if (note || result.archive !== null) fail("preservation_failed");
          } else {
            if (
              !commit ||
              typeof result.archive !== "string" ||
              !note?.startsWith("unpushed work preserved at work_recovery:")
            )
              fail("preservation_failed");
            await verifyRecovery(result.archive, item.repo, commit);
            verifiedArchive = result.archive;
          }
        });
        if (dirty) {
          await measuredStep("preservation_recovery_handle", async () => {
            const parts = note?.slice("unpushed work preserved at work_recovery:".length).split("/");
            if (
              parts?.length !== 2 ||
              parts[0]?.toLowerCase() !== sandboxId?.toLowerCase() ||
              !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(parts[1] ?? "")
            )
              fail("preservation_failed");
            verifiedRecoveryId = parts[1];
            const explicit = await sandbox<{ archive: string | null }>("recovery", {
              id: sandboxId,
              recovery_id: parts[1],
            });
            if (!verifiedArchive || explicit.archive !== verifiedArchive) fail("preservation_failed");
          });
        }
        if (dirty)
          await measuredStep("preservation_unknown_handle_refused", async () => {
            const absent = await sandbox<{ archive: string | null }>("recovery", {
              id: sandboxId,
              recovery_id: crypto.randomUUID(),
            });
            if (absent.archive !== null) fail("preservation_failed");
          });
        await measuredStep("preservation_recovery_read_only", async () => {
          if (dirty) {
            const repeated = await sandbox<{ archive: string | null }>("recovery", { id: sandboxId });
            if (repeated.archive !== verifiedArchive) fail("preservation_failed");
          }
          const after = await sandbox<{ status: string; providerState: string; preservationNote?: string | null }>(
            "status",
            { id: sandboxId },
          );
          if (after.status !== "stopped" || after.providerState !== "stopped") fail("provider_not_stopped");
          stopped = true;
          if (dirty ? after.preservationNote !== note : !!after.preservationNote) fail("preservation_failed");
        });
      }
      if (lifecycle && !dirty) {
        await measuredStep("list_stopped", () => consistent("stopped"));
        // send is the existing resume operation. Invalidate the old stop handle
        // BEFORE dispatch, so a lost response still requires cleanup.
        stopped = false;
        stopRequested = false;
        preservationNote = undefined;
        await nativeTurn(true, "resume");
        await measuredStep("list_resumed", () => consistent("ready"));
        await measuredStep("stop_resumed", stopSandbox);
        await measuredStep("list_stopped_final", () => consistent("stopped"));
      }
    }
    try {
      await run();
    } catch {
      passed = false;
    } finally {
      if (github && sandboxId && pushAttempted) {
        try {
          await withCleanup(() =>
            step("cleanup_scratch_branch", async () => {
              await checkedExec(remoteGuard);
              const presence = await sandbox<{ exitCode: number | null; timedOut: boolean }>("exec", {
                id: sandboxId,
                command: `${git} ls-remote --exit-code origin refs/heads/${scratch}`,
                cwd: item.repo,
                timeout_seconds: 60,
              });
              if (presence?.timedOut !== false || (presence.exitCode !== 0 && presence.exitCode !== 2))
                fail("exec_failed");
              if (presence.exitCode === 0)
                await checkedExec(`${remoteGuard} && ${git} push origin --delete ${scratch}`);
              io.out(
                JSON.stringify({
                  case: index,
                  step: "scratch_branch_cleanup",
                  outcome: presence.exitCode === 2 ? "absent" : "deleted",
                }),
              );
            }),
          );
        } catch {
          passed = false;
        }
      }
      if (sandboxId && !stopped) {
        try {
          await withCleanup(() =>
            step(scoped ? "scoped_parent_cleanup" : "cleanup_sandbox", () => stopSandbox(undefined, !!scoped)),
          );
        } catch {
          passed = false;
        }
      }
    }
    if (scoped) return (await scoped.cleanup(sandboxId, stopped, launchAttempted)) && passed;
    if (preservation)
      io.out(
        JSON.stringify({
          case: index,
          step: "preservation_cleanup_summary",
          pass: !!sandboxId && stopped,
          phase: dirty ? "archive" : "clean",
          leftoverSandboxIds: sandboxId && !stopped ? [sandboxId] : [],
          launchOutcomeUnknown: launchAttempted && !sandboxId,
          recoveryId: verifiedRecoveryId ?? null,
          org: item.org,
          golden: item.golden,
          startedAt: new Date(startedAt).toISOString(),
        }),
      );
    if (lifecycle)
      io.out(
        JSON.stringify({
          case: index,
          phase: dirty ? "preservation" : "lifecycle",
          step: "lifecycle_cleanup_summary",
          pass: !!sandboxId && stopped,
          provider: item.provider,
          harness: item.harness,
          elapsedMs: io.now() - startedAt,
          leftoverSandboxIds: sandboxId && !stopped ? [sandboxId] : [],
          launchOutcomeUnknown: launchAttempted && !sandboxId,
          startedAt: new Date(startedAt).toISOString(),
          org: item.org,
          golden: item.golden,
        }),
      );
    return passed;
  }
}

async function runAllowedSmoke(env: NodeJS.ProcessEnv, args: readonly string[], io: SmokeIo): Promise<boolean> {
  if (args[0] === "--parity") return providerParitySmoke(env, io, args.slice(1));
  let cases: unknown[];
  try {
    cases = stagingSmokeCases(JSON.parse(env.ARMADA_SMOKE_CASES ?? ""));
  } catch {
    io.out(JSON.stringify({ step: "configure", pass: false, code: "invalid_configuration" }));
    return false;
  }
  return runPostDeploySmoke({ ...env, ARMADA_SMOKE_CASES: JSON.stringify(cases) }, args, io);
}

/** Persist handles before callers inspect receipts; cleanup also runs after failed probes. */
export async function postDeploySmoke(env: NodeJS.ProcessEnv, args: readonly string[], io: SmokeIo): Promise<boolean> {
  // Coordinator-only opt-in never reads or sweeps the staging cleanup journal.
  if (args.includes("--production-boat")) {
    if (args[0] !== "--parity") {
      io.out(JSON.stringify({ step: "configure", pass: false, code: "production_boat_requires_parity" }));
      return false;
    }
    return providerParitySmoke(env, { fetch: io.fetch, sleep: io.sleep, now: io.now, out: io.out }, args.slice(1));
  }
  io.out(BOAT_STAGING_NOTICE);
  const out = io.out;
  io = {
    ...io,
    out: (line) => {
      if (line !== BOAT_STAGING_NOTICE) out(line);
    },
  };
  const path = env.ARMADA_SMOKE_JOURNAL;
  if (!path) return runAllowedSmoke(env, args, io);
  if (
    env.ARMADA_URL !== STAGING_ORIGIN ||
    !env.ARMADA_TOKEN ||
    env.ARMADA_SMOKE !== "create_real_compute" ||
    args.includes("--orchestrator")
  ) {
    io.out(JSON.stringify({ step: "smoke_cleanup_configure", pass: false }));
    return false;
  }
  let rows: SmokeSandboxReceipt[];
  try {
    rows = await readSmokeJournal(path);
  } catch {
    io.out(JSON.stringify({ step: "smoke_cleanup_journal", pass: false }));
    return false;
  }
  // Historical receipts did not record provider. Never contact Boat to classify them.
  const deferred = rows.filter((row) => row.provider !== "modal" && row.provider !== "docker");
  rows = rows.filter((row) => row.provider === "modal" || row.provider === "docker");
  if (deferred.length)
    io.out(
      JSON.stringify({
        step: "smoke_cleanup_deferred",
        count: deferred.length,
        reason: "provider_unverified_or_excluded",
        requiresOperator: true,
      }),
    );
  rows = await deleteSmokeReceipts(STAGING_ORIGIN, env.ARMADA_TOKEN, rows, io, { stopFirst: true });
  await saveSmokeJournal(path, [...deferred, ...rows]);
  const earlierRows = rows;
  rows = [];
  let passed = false;
  let unknownLaunch = false;
  const unacknowledgedLaunches = new Set<string>();
  const parityDeletes = new Map<string, boolean>();
  const trackedIo: SmokeIo = {
    ...io,
    recordSandboxDelete: (org, id, accepted) => parityDeletes.set(`${org}/${id}`, accepted),
    recordSandbox: async (org, id, requestKey, provider) => {
      if (!rows.some((row) => row.id === id)) rows.push({ org, id, requestKey, ...(provider ? { provider } : {}) });
      await saveSmokeJournal(path, [...deferred, ...earlierRows, ...rows]);
      unacknowledgedLaunches.delete(requestKey);
    },
    fetch: async (url, init, receipt) => {
      const launch = /\/api\/v1\/(sandbox\/launch|templates\/launch)$/.test(url);
      if (!launch) return io.fetch(url, init);
      const body = JSON.parse(String(init.body));
      const key = body.externalRef;
      const requestKey =
        typeof key === "string" &&
        /^post-deploy-smoke:[0-9a-f-]{36}$/.test(key) &&
        (key === body.idempotencyKey || (url.endsWith("/templates/launch") && key === body.requestKey))
          ? key
          : `post-deploy-smoke:${crypto.randomUUID()}`;
      const org = body.org;
      let response: Response;
      try {
        response = await io.fetch(url, init);
      } catch (error) {
        unacknowledgedLaunches.add(requestKey);
        throw error;
      }
      const result = (await response
        .clone()
        .json()
        .catch(() => null)) as {
        sandbox?: { id?: unknown; provider?: unknown; externalRef?: unknown };
        provider?: unknown;
        manifest?: { definition?: { provider?: unknown } };
        state?: unknown;
        id?: unknown;
      } | null;
      const keyedDockerLaunch = url.endsWith("/sandbox/launch") && requestKey === key && body.provider === "docker";
      const keyedModalLaunch = args[0] === "--parity" && requestKey === key && body.provider === "modal";
      const keyedLaunch = keyedModalLaunch || keyedDockerLaunch;
      const id = keyedLaunch ? result?.sandbox?.id : (result?.sandbox?.id ?? result?.id);
      const admissionProvider =
        receipt &&
        url.endsWith("/sandbox/launch") &&
        requestKey === key &&
        response.ok &&
        isSandboxPlacementProvider(body.provider) &&
        parseLaunchAdmissionReceipt(body.provider, result)
          ? body.provider
          : undefined;
      const provider = admissionProvider ?? smokeReceiptProvider(result);
      const unverifiedLaunch =
        keyedLaunch &&
        (!response.ok ||
          provider !== body.provider ||
          result?.sandbox?.provider !== body.provider ||
          (keyedDockerLaunch && result?.sandbox?.externalRef !== key));
      if (!unverifiedLaunch && typeof id === "string" && SANDBOX_ID.test(id) && typeof org === "string") {
        const row: SmokeSandboxReceipt = {
          requestKey,
          org,
          id,
          ...(provider === "boat" || provider === "modal" || provider === "docker" ? { provider } : {}),
        };
        if (!row.provider || row.provider === "boat") unknownLaunch = true;
        rows.push(row);
        await saveSmokeJournal(path, [...deferred, ...earlierRows, ...rows]);
        io.out(JSON.stringify({ step: "smoke_sandbox_receipt", ...row }));
      } else if (response.ok || (requestKey === key && response.status >= 500)) {
        unacknowledgedLaunches.add(requestKey);
      }
      return response;
    },
  };
  try {
    passed = await runAllowedSmoke(env, args, trackedIo);
  } finally {
    unknownLaunch ||= unacknowledgedLaunches.size > 0;
    deferred.push(...rows.filter((row) => row.provider !== "modal" && row.provider !== "docker"));
    rows = rows.filter((row) => row.provider === "modal" || row.provider === "docker");
    const parityFailures = rows.filter((row) => parityDeletes.get(`${row.org}/${row.id}`) === false);
    const untouched = rows.filter((row) => !parityDeletes.has(`${row.org}/${row.id}`));
    rows = await deleteSmokeReceipts(STAGING_ORIGIN, env.ARMADA_TOKEN, untouched, io, { limit: 64 });
    rows = [...earlierRows, ...parityFailures, ...rows];
    await saveSmokeJournal(path, [...deferred, ...rows]);
    io.out(
      JSON.stringify({
        step: "smoke_cleanup_summary",
        pass: rows.length === 0 && !unknownLaunch,
        remainingRows: rows.length,
        deferredRows: deferred.length,
        scope: "modal_docker_receipts",
        launchOutcomeUnknown: unknownLaunch,
      }),
    );
  }
  return passed && rows.length === 0 && !unknownLaunch;
}

if (import.meta.main) {
  const passed = await postDeploySmoke(process.env, Bun.argv.slice(2), {
    fetch: (url, init) => fetch(url, { ...init, ...{ timeout: false } }),
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    out: (line) => console.log(line),
  });
  if (!passed) process.exitCode = 1;
}

import { HARNESS_CATALOG, type Harness, isHarness } from "../packages/core/src/harnesses.ts";
import { providerParitySmoke } from "./provider-parity-smoke.ts";
import {
  deleteSmokeReceipts,
  readSmokeJournal,
  type SmokeSandboxReceipt,
  STAGING_ORIGIN,
  saveSmokeJournal,
} from "./smoke-sandbox-cleanup.ts";
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
import { DefaultSkillSmokeFailure, readDefaultPins, verifyDefaultReceipts } from "./default-skill-smoke.ts";
import { ExpirySmokeFailure, runExpiryCase } from "./expiry-smoke.ts";
import { helperProbe, skillpackProbe } from "./golden-runtime-smoke.ts";
import { createScopedProbe, ScopedAccessSmokeFailure } from "./scoped-access-smoke.ts";
import { runTemplateSkillCase, TemplateSkillSmokeFailure } from "./template-skill-smoke.ts";
import { runVaultCase, VaultSmokeFailure } from "./vault-smoke.ts";

type Code =
  | ApiFailureCode
  | "sandbox_not_ready"
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
  ) {
    super(code);
  }
}
function fail(code: Code): never {
  throw new SmokeFailure(code);
}
interface SmokeCase {
  provider: "boat" | "modal";
  harness: Harness;
  org: string;
  golden: string;
  model: string;
  modelAccountId: string;
  repo: string;
  goldenId?: string;
  reasoningEffort?: string;
  disposableRepository?: string;
  publicSkill?: string;
  privateSkill?: string;
}
interface SmokeIo {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  out: (line: string) => void;
  recordSandbox?: (org: string, id: string, key: string) => Promise<void>;
}
const POLLS = 120;
const PROMPT = "Reply with exactly SMOKE_OK and do not use tools.";

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
async function runPostDeploySmoke(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  io: SmokeIo,
  cleanupEnd?: number,
): Promise<boolean> {
  if (args.length === 1 && args[0] === "--parity") return providerParitySmoke(env, io);
  function report(index: number, step: string, error?: unknown) {
    io.out(
      JSON.stringify({
        case: index,
        step,
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
  try {
    if (env.ARMADA_SMOKE !== "create_real_compute") fail("compute_opt_in_required");
    if (
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
          arg !== "--vault",
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
        vault) &&
      origin !== "https://armada-mcp-staging.up.railway.app"
    )
      fail("invalid_configuration");
    const parsed: unknown = JSON.parse(env.ARMADA_SMOKE_CASES);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) fail("invalid_configuration");
    for (const item of parsed) {
      if (
        !item ||
        typeof item !== "object" ||
        (item.provider !== "boat" && item.provider !== "modal") ||
        !isHarness(item.harness) ||
        (item.provider === "boat" && HARNESS_CATALOG[item.harness as Harness].boatProvider === null) ||
        ["org", "golden", "model", "modelAccountId", "repo"].some(
          (key) => typeof item[key] !== "string" || !item[key].trim(),
        ) ||
        !item.repo.startsWith("/") ||
        (scopedAccess &&
          item.harness === "codex" &&
          [item.org, item.goldenId, item.modelAccountId].some(
            (value) => typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value),
          )) ||
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
      for (const item of parsed) {
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
      const pairs = new Set(parsed.map((item) => `${item.provider}/${item.harness}`));
      if (parsed.length !== 4 || pairs.size !== 4) fail("invalid_configuration");
      for (const item of parsed) {
        if (
          typeof item.disposableRepository !== "string" ||
          !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(item.disposableRepository)
        )
          fail("invalid_configuration");
      }
    }
    cases = parsed.map((item) =>
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
  // Reserve the final five minutes for best-effort cleanup, independently of a failed step.
  const deadline = Math.min(io.now() + 35 * 60_000, (cleanupEnd ?? Number.POSITIVE_INFINITY) - 5 * 60_000);
  const cleanupDeadline = deadline + 5 * 60_000;
  let cleaning = false;
  const protectedCanaries = new Set<string>();
  async function request<T>(path: string, body?: unknown, key?: string, timeoutMs = 120_000): Promise<T> {
    const remaining = (cleaning ? cleanupDeadline : deadline) - io.now();
    if (remaining <= 0) fail("poll_limit_exceeded");
    try {
      const response = await io.fetch(`${origin}/api/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${env.ARMADA_TOKEN}`,
          accept: "application/json",
          "content-type": "application/json",
          ...(key ? { "idempotency-key": key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
        if ([...protectedCanaries].some((value) => JSON.stringify(payload).includes(value)))
          throw new VaultSmokeFailure("secret_exposed");
        const code = payload?.error?.code;
        throw new SmokeFailure(
          typeof code === "string" && API_CODES.has(code as Code) ? (code as Code) : "api_failed",
          response.status,
        );
      }
      try {
        return (await response.json()) as T;
      } catch {
        fail("invalid_response");
      }
    } catch (error) {
      if (error instanceof SmokeFailure || error instanceof VaultSmokeFailure) throw error;
      fail("request_failed");
    }
  }
  async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, limit = POLLS): Promise<T> {
    for (let i = 0; i < limit; i++) {
      const value = await read();
      if (done(value)) return value;
      if (i + 1 < limit) await io.sleep(1000);
    }
    fail("poll_limit_exceeded");
  }
  const defaultPins = new Map<number, string[]>();
  if (defaultSkills) {
    for (const [index, item] of cases.entries()) {
      try {
        const pins = await readDefaultPins(item.org, item.goldenId!, {
          request,
          step: async (name, action) => {
            try {
              const value = await action();
              report(index, name);
              return value;
            } catch (error) {
              report(index, name, error);
              throw error;
            }
          },
        });
        defaultPins.set(index, pins);
        report(index, "default_skills_policy");
      } catch (error) {
        report(index, "default_skills_policy", error);
        return false;
      }
    }
  }
  let vaultPassed = true;
  if (vault) {
    for (const [index, item] of cases.entries()) {
      const ok = await runVaultCase(item.org, {
        request,
        protect: (value) => protectedCanaries.add(value),
        isFailure: (error, status, code) =>
          error instanceof SmokeFailure && error.status === status && error.code === code,
        step: async (name, action) => {
          try {
            const value = await action();
            report(index, name);
            return value;
          } catch (error) {
            report(index, name, error);
            throw error;
          }
        },
        out: (line) => io.out(JSON.stringify({ ...JSON.parse(line), case: index })),
        withCleanup: async (action) => {
          cleaning = true;
          try {
            return await action();
          } finally {
            cleaning = false;
          }
        },
      });
      if (!ok) vaultPassed = false;
    }
    if (args.every((arg) => arg === "--vault")) return vaultPassed;
  }
  let templateSkillsPassed = true;
  if (templatesSkills) {
    for (const [index, item] of cases.entries()) {
      const ok = await runTemplateSkillCase(
        { ...item, goldenId: item.goldenId! },
        {
          request: (path, body) => request(path, body, undefined, path === "templates/launch" ? 600_000 : 120_000),
          poll,
          step: async (name, action) => {
            try {
              const value = await action();
              report(index, name);
              return value;
            } catch (error) {
              report(index, name, error);
              throw error;
            }
          },
          out: (line) => io.out(JSON.stringify({ ...JSON.parse(line), case: index })),
          withCleanup: async (action) => {
            cleaning = true;
            try {
              return await action();
            } finally {
              cleaning = false;
            }
          },
          stopSandbox: async (id) => {
            try {
              await request("sandbox/stop", { org: item.org, id });
            } catch (error) {
              if (!(error instanceof SmokeFailure) || error.code !== "outcome_unknown") throw error;
            }
            await poll(
              () => request<{ status: string; providerState: string }>("sandbox/status", { org: item.org, id }),
              (result) => {
                if (result.status !== "stopped" && result.status !== "failed") return false;
                if (result.providerState !== (item.provider === "boat" ? "archived" : "stopped"))
                  fail("provider_not_stopped");
                return true;
              },
            );
          },
        },
      );
      if (!ok) templateSkillsPassed = false;
    }
    // This mode is independently runnable; combined staging runs keep the existing
    // preservation baseline as well, under the same shared deadline.
    if (!preservation && !lifecycle) return templateSkillsPassed && vaultPassed;
  }
  let expiryPassed = true;
  if (expiry) {
    for (const [index, item] of cases.entries()) {
      const result = await runExpiryCase(item, {
        request,
        now: io.now,
        sleep: io.sleep,
        out: (line) => io.out(JSON.stringify({ ...JSON.parse(line), case: index })),
        step: async (name, action) => {
          try {
            const value = await action();
            report(index, name);
            return value;
          } catch (error) {
            report(index, name, error);
            throw error;
          }
        },
        withCleanup: async (action) => {
          cleaning = true;
          try {
            return await action();
          } finally {
            cleaning = false;
          }
        },
      });
      expiryPassed &&= result;
    }
    if (args.length === 1) return expiryPassed;
  }
  let passed = templateSkillsPassed && vaultPassed && expiryPassed;
  for (const { index, item, dirty } of cases.flatMap((item, index) =>
    (preservation ? [false, true] : [false]).map((dirty) => ({ index, item, dirty })),
  )) {
    async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
      try {
        const value = await action();
        report(index, name);
        return value;
      } catch (error) {
        report(index, name, error);
        throw error;
      }
    }
    const sandbox = <T>(action: string, body: object, timeoutMs?: number) =>
      request<T>(`sandbox/${action}`, { org: item.org, ...body }, undefined, timeoutMs);
    const scopedPair = scopedAccess && item.harness === "codex";
    let parentCredentialVersion: number | undefined;
    const scoped = scopedPair
      ? createScopedProbe({ ...item, goldenId: item.goldenId! }, !dirty, {
          request: (path, body) => request(path, { ...body, org: item.org }),
          recordSandbox: (id, key) => io.recordSandbox?.(item.org, id, key) ?? Promise.resolve(),
          poll: (read, done) => poll(read, done, 300),
          step,
          withCleanup: async (action) => {
            cleaning = true;
            try {
              return await action();
            } finally {
              cleaning = false;
            }
          },
          isNotReady: (error) => error instanceof SmokeFailure && error.code === "sandbox_not_ready",
          out: (line) => io.out(JSON.stringify({ ...JSON.parse(line), case: index })),
          stopSandbox: async (id) => {
            try {
              await sandbox("stop", { id });
            } catch (error) {
              if (!(error instanceof SmokeFailure) || !["outcome_unknown", "request_failed"].includes(error.code))
                throw error;
            }
            await poll(
              () => sandbox<{ id: string; status: string; providerState: string }>("status", { id }),
              (status) =>
                status.id === id &&
                ["stopped", "failed"].includes(status.status) &&
                ["archived", "stopped"].includes(status.providerState),
            );
          },
        })
      : undefined;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
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
    let sandboxId: string | undefined;
    let commit: string | undefined;
    const preservationMarker = crypto.randomUUID();
    let stopped = false;
    let stopRequested = false;
    let preservationNote: string | undefined;
    async function stopSandbox() {
      if (!stopRequested) {
        try {
          const receipt = await sandbox<{ preservationNote?: string }>("stop", { id: sandboxId });
          preservationNote = receipt.preservationNote;
        } catch (error) {
          // The stop may already be in flight. Observe it; never replay an unknown mutation.
          if (!(error instanceof SmokeFailure) || error.code !== "outcome_unknown") throw error;
        }
        stopRequested = true;
      }
      await poll(
        () =>
          sandbox<{ status: string; providerState: string; preservationNote?: string }>("status", { id: sandboxId }),
        (status) => {
          if (status.status !== "stopped" && status.status !== "failed") return false;
          if (status.providerState !== (item.provider === "boat" ? "archived" : "stopped"))
            fail("provider_not_stopped");
          if (
            status.providerState === "stopped" &&
            [preservationNote, status.preservationNote].some((note) =>
              note?.includes("checkpoint_failed_disk_not_retained"),
            )
          )
            io.out(
              JSON.stringify({ case: index, step: "stop_warning", warning: "checkpoint_failed_disk_not_retained" }),
            );
          preservationNote = status.preservationNote ?? preservationNote;
          return true;
        },
      );
      stopped = true;
    }
    try {
      if (scoped) await scoped.prepare();
      else if (scopedAccess && !dirty)
        io.out(JSON.stringify({ case: index, step: "scoped_access", skip: true, reason: "codex_only" }));
      await step("launch", async () => {
        launchAttempted = true;
        const result = await sandbox<{
          sandbox: {
            id: string;
            provider: string;
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
        }>(
          scopedPair && !dirty ? "launch-access-v1" : "launch",
          {
            ...(scopedPair && !dirty ? { armadaAccessVersion: 1, armadaAccess: { maxActiveChildren: 1 } } : {}),
            golden: item.golden,
            provider: item.provider,
            harness: item.harness,
            model: item.model,
            credentialId: item.modelAccountId,
            ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
            connections: [],
            ...((defaultSkills || scopedPair) && dirty ? { skipSkillDefaults: true } : {}),
            ttlSeconds: 1800,
          },
          600_000,
        );
        // Retain the cleanup handle even if later response validation fails.
        if (typeof result?.sandbox?.id === "string" && result.sandbox.id) sandboxId = result.sandbox.id;
        if (!sandboxId || result.sandbox.provider !== item.provider || result.promptId) fail("invalid_response");
        if ((defaultSkills || scopedPair) && result.golden?.id !== item.goldenId) fail("invalid_response");
        if (scopedPair)
          await step("scoped_parent_configuration", async () => {
            if (
              result.sandbox.harness !== item.harness ||
              result.sandbox.model !== item.model ||
              (item.reasoningEffort && result.sandbox.reasoningEffort !== item.reasoningEffort) ||
              result.sandbox.credentialId !== item.modelAccountId ||
              !Number.isSafeInteger(result.sandbox.credentialVersion) ||
              Number(result.sandbox.credentialVersion) < 1 ||
              (dirty
                ? result.armadaAccess?.enabled === true
                : result.armadaAccess?.enabled !== true ||
                  result.armadaAccess.maxActiveChildren !== 1 ||
                  result.sandbox.visibility !== "private")
            )
              fail("invalid_response");
            parentCredentialVersion = result.sandbox.credentialVersion;
          });
        launchSkills = result.sandbox.skills;
      });
      await step("ready", () =>
        poll(
          () => sandbox<{ status: string }>("status", { id: sandboxId }),
          (result) => {
            if (result.status === "failed" || result.status === "stopped") fail("sandbox_not_ready");
            return result.status === "ready";
          },
        ),
      );
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
      if (goldenRuntime && !dirty) {
        await step("golden_helper_integrity", () => checkedExec(helperProbe));
        await step("golden_skillpack_integrity", () => checkedExec(skillpackProbe));
      }
      if (githubRefresh && !dirty)
        await step("github_launch_access", () => checkedExec(`${git} ls-remote origin HEAD >/dev/null 2>&1`));
      if (defaultSkills) {
        const expected = defaultPins.get(index)!;
        await step(dirty ? "default_skills_opt_out_receipts" : "default_skills_receipts", async () => {
          const status = await sandbox<{ skills?: unknown }>("status", { id: sandboxId });
          verifyDefaultReceipts(launchSkills, status.skills, dirty ? [] : expected);
        });
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
      async function consistent(expected: string) {
        const status = await sandbox<{ id: string; harness: string; status: string; expiresAt: string | null }>(
          "status",
          { id: sandboxId },
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
          }>("list", { owner: "me", harness: item.harness, status: [expected], limit: 200, page });
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
        const turn = await step(phase ? `${phase}_send` : second ? "send_second" : "send", async () => {
          const result = await poll(
            async () => {
              try {
                return await sandbox<{ promptId: string }>("send", {
                  id: sandboxId,
                  prompt: github
                    ? `Run exactly this shell command using your terminal tool, without reading credentials or making other changes: ${commands}`
                    : PROMPT,
                });
              } catch (error) {
                // Only this closed rejection guarantees the prompt was not admitted.
                if (!(error instanceof SmokeFailure) || error.code !== "sandbox_not_ready") throw error;
                return null;
              }
            },
            (result) => result !== null,
          );
          if (!result?.promptId || typeof result.promptId !== "string") fail("invalid_response");
          return result;
        });
        await step(phase ? `${phase}_wait` : "wait", () =>
          poll(
            () =>
              sandbox<{ prompt: { promptId: string; state: string } | null }>("wait", {
                id: sandboxId,
                prompt_id: turn.promptId,
                timeout_seconds: 0,
              }),
            (result) => {
              if (!result?.prompt || result.prompt.promptId !== turn.promptId) fail("invalid_response");
              if (result.prompt.state === "failed" || result.prompt.state === "interrupted") fail("turn_failed");
              if (result.prompt.state !== "running" && result.prompt.state !== "finished") fail("invalid_response");
              return result.prompt.state === "finished";
            },
          ),
        );
        if (item.provider === "modal")
          await step(phase ? `${phase}_usage` : second ? "usage_second" : "usage", () =>
            poll(
              () =>
                sandbox<{
                  usage?: {
                    turns?: {
                      promptId: string;
                      inputTokens: number | null;
                      outputTokens: number | null;
                      cachedTokens?: number | null;
                    }[];
                    tokenTotals?: { inputTokens: number | null; outputTokens: number | null; incomplete?: boolean };
                  };
                }>("status", { id: sandboxId }),
              (result) => {
                const row = result.usage?.turns?.find((row) => row.promptId === turn.promptId);
                // A resumed prompt must be measured, not an explicit unknown receipt.
                return (
                  result.usage?.tokenTotals?.incomplete !== true &&
                  typeof row?.inputTokens === "number" &&
                  typeof row.outputTokens === "number" &&
                  typeof result.usage?.tokenTotals?.inputTokens === "number" &&
                  typeof result.usage?.tokenTotals?.outputTokens === "number"
                );
              },
            ),
          );
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
        await step("preservation_clean_checkout", () =>
          checkedExec(
            `test -z "$(${git} status --porcelain)" && test -z "$(${git} rev-list HEAD --branches --tags --not --remotes)"`,
          ),
        );
      await nativeTurn(false);
      if (scoped) await scoped.run(sandboxId!, parentCredentialVersion!);
      if (lifecycle && !dirty) {
        await step("list_ready", () => consistent("ready"));
        await step("steer_refused", async () => {
          try {
            await sandbox("steer", { id: sandboxId, text: "Smoke: no turn should be running." });
          } catch (error) {
            if (error instanceof SmokeFailure && error.code === "no_running_turn" && error.status === 409) return;
            throw error;
          }
          fail("steer_not_refused");
        });
        await step("extend", async () => {
          const before = await sandbox<{ expiresAt: string }>("status", { id: sandboxId });
          const previous = Date.parse(before.expiresAt);
          if (!Number.isFinite(previous)) fail("invalid_response");
          // A modest extension fits Modal's existing launch headroom; no wall-clock wait.
          const extension = await sandbox<{ id: string; expiresAt: string; ttlSeconds: number }>("extend", {
            id: sandboxId,
            ttl_seconds: 1860,
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
        await step(name, async () => {
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
        if (item.provider === "modal") {
          await step("github_refresh_unsupported", async () => {
            try {
              await request("github/refresh", { org: item.org, id: sandboxId });
            } catch (error) {
              if (error instanceof SmokeFailure && error.code === "unsupported" && error.status === 400) return;
              throw error;
            }
            fail("invalid_receipt");
          });
          io.out(
            JSON.stringify({ case: index, step: "github_refresh_idempotency", skip: true, reason: "legacy_boat_only" }),
          );
        } else {
          let login: string | undefined;
          for (const phase of ["first", "second"]) {
            await step(`github_refresh_${phase}`, async () => {
              const result = await request<{ id: string; status: string; login: string }>("github/refresh", {
                org: item.org,
                id: sandboxId,
              });
              if (
                result?.id !== sandboxId ||
                result.status !== "connected" ||
                typeof result.login !== "string" ||
                !/^[A-Za-z0-9-]{1,39}$/.test(result.login) ||
                (login !== undefined && result.login !== login)
              )
                fail("invalid_receipt");
              login = result.login;
            });
            await step(`github_refresh_access_${phase}`, () =>
              checkedExec(`${git} ls-remote origin HEAD >/dev/null 2>&1`),
            );
          }
        }
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
        await step("preservation_commit", async () => {
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
      if (!github) await step("stop", stopSandbox);
      if (preservation) {
        // Recovery is a read-only operation, but do not reuse the earlier stop
        // receipt if verification fails or a regression wakes the worker.
        stopped = false;
        stopRequested = false;
        let verifiedArchive: string | undefined;
        const note = preservationNote;
        await step(dirty ? "preservation_archive" : "preservation_clean_stop", async () => {
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
          await step("preservation_recovery_handle", async () => {
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
          await step("preservation_unknown_handle_refused", async () => {
            const absent = await sandbox<{ archive: string | null }>("recovery", {
              id: sandboxId,
              recovery_id: crypto.randomUUID(),
            });
            if (absent.archive !== null) fail("preservation_failed");
          });
        await step("preservation_recovery_read_only", async () => {
          if (dirty) {
            const repeated = await sandbox<{ archive: string | null }>("recovery", { id: sandboxId });
            if (repeated.archive !== verifiedArchive) fail("preservation_failed");
          }
          const after = await sandbox<{ status: string; providerState: string; preservationNote?: string | null }>(
            "status",
            { id: sandboxId },
          );
          if (after.status !== "stopped" || after.providerState !== (item.provider === "boat" ? "archived" : "stopped"))
            fail("provider_not_stopped");
          stopped = true;
          if (dirty ? after.preservationNote !== note : !!after.preservationNote) fail("preservation_failed");
        });
      }
      if (lifecycle && !dirty) {
        await step("list_stopped", () => consistent("stopped"));
        // send is the existing resume operation. Invalidate the old stop handle
        // BEFORE dispatch, so a lost response still requires cleanup.
        stopped = false;
        stopRequested = false;
        preservationNote = undefined;
        await nativeTurn(true, "resume");
        await step("list_resumed", () => consistent("ready"));
        await step("stop_resumed", stopSandbox);
        await step("list_stopped_final", () => consistent("stopped"));
      }
    } catch {
      passed = false;
    } finally {
      if (github && sandboxId && pushAttempted) {
        cleaning = true;
        try {
          await step("cleanup_scratch_branch", async () => {
            await checkedExec(remoteGuard);
            const presence = await sandbox<{ exitCode: number | null; timedOut: boolean }>("exec", {
              id: sandboxId,
              command: `${git} ls-remote --exit-code origin refs/heads/${scratch}`,
              cwd: item.repo,
              timeout_seconds: 60,
            });
            if (presence?.timedOut !== false || (presence.exitCode !== 0 && presence.exitCode !== 2))
              fail("exec_failed");
            if (presence.exitCode === 0) await checkedExec(`${remoteGuard} && ${git} push origin --delete ${scratch}`);
            io.out(
              JSON.stringify({
                case: index,
                step: "scratch_branch_cleanup",
                outcome: presence.exitCode === 2 ? "absent" : "deleted",
              }),
            );
          });
        } catch {
          passed = false;
        } finally {
          cleaning = false;
        }
      }
      if (sandboxId && !stopped) {
        cleaning = true;
        try {
          await step("cleanup_sandbox", stopSandbox);
        } catch {
          passed = false;
        } finally {
          cleaning = false;
        }
      }
    }
    if (scoped && !(await scoped.cleanup(sandboxId, stopped, launchAttempted))) passed = false;
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
  }
  return passed;
}

/** Persist handles before callers inspect receipts; cleanup also runs after failed probes. */
export async function postDeploySmoke(env: NodeJS.ProcessEnv, args: readonly string[], io: SmokeIo): Promise<boolean> {
  const path = env.ARMADA_SMOKE_JOURNAL;
  if (!path) return runPostDeploySmoke(env, args, io);
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
  const cleanupEnd = io.now() + 40 * 60_000;
  const cleanupIo = { fetch: io.fetch, out: io.out, now: io.now, sleep: io.sleep, deadline: cleanupEnd };
  rows = await deleteSmokeReceipts(STAGING_ORIGIN, env.ARMADA_TOKEN, rows, cleanupIo);
  await saveSmokeJournal(path, rows);
  const earlierRows = rows;
  rows = [];
  let passed = false;
  let unknownLaunch = false;
  const trackedIo: SmokeIo = {
    ...io,
    recordSandbox: async (org, id, requestKey) => {
      if (!rows.some((row) => row.id === id)) rows.push({ org, id, requestKey });
      await saveSmokeJournal(path, [...earlierRows, ...rows]);
    },
    fetch: async (url, init) => {
      const launch = /\/api\/v1\/(sandbox\/launch(?:-access-v1)?|templates\/launch)$/.test(url);
      if (!launch) {
        // Scoped probe children are attributed by its verified native launch claims,
        // never by a difference of fleet-wide stopped rows.
        if (url.endsWith("/api/v1/sandbox/stop")) {
          const body = JSON.parse(String(init.body));
          if (typeof body.id === "string" && typeof body.org === "string" && !rows.some((row) => row.id === body.id)) {
            const row = { requestKey: `post-deploy-smoke:${crypto.randomUUID()}`, org: body.org, id: body.id };
            rows.push(row);
            await saveSmokeJournal(path, [...earlierRows, ...rows]);
            io.out(JSON.stringify({ step: "smoke_sandbox_receipt", ...row }));
          }
        }
        return io.fetch(url, init);
      }
      const requestKey = `post-deploy-smoke:${crypto.randomUUID()}`;
      const org = JSON.parse(String(init.body)).org;
      let response: Response;
      try {
        response = await io.fetch(url, init);
      } catch (error) {
        unknownLaunch = true;
        throw error;
      }
      const result = (await response
        .clone()
        .json()
        .catch(() => null)) as {
        sandbox?: { id?: unknown };
        state?: unknown;
        id?: unknown;
      } | null;
      const id = result?.sandbox?.id ?? (result?.state === "succeeded" ? result.id : undefined);
      if (typeof id === "string" && typeof org === "string") {
        const row = { requestKey, org, id };
        rows.push(row);
        await saveSmokeJournal(path, [...earlierRows, ...rows]);
        io.out(JSON.stringify({ step: "smoke_sandbox_receipt", ...row }));
      } else if (response.ok) unknownLaunch = true;
      return response;
    },
  };
  try {
    passed = await runPostDeploySmoke(env, args, trackedIo, cleanupEnd);
  } finally {
    rows = await deleteSmokeReceipts(STAGING_ORIGIN, env.ARMADA_TOKEN, rows, cleanupIo, 64);
    rows = [...earlierRows, ...rows];
    await saveSmokeJournal(path, rows);
    io.out(
      JSON.stringify({
        step: "smoke_cleanup_summary",
        pass: rows.length === 0 && !unknownLaunch,
        remainingRows: rows.length,
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

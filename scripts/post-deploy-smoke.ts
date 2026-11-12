/** API-only smoke; ARMADA_SMOKE=create_real_compute explicitly authorizes compute.
 * ARMADA_URL must be an HTTPS origin; ARMADA_TOKEN is the only credential.
 * ARMADA_SMOKE_CASES is a JSON array of {provider, harness, org, golden, model,
 * modelAccountId, repo, goldenId?, reasoningEffort?}. golden is a launch name;
 * repo is an absolute sandbox cwd for exec. goldenId is required with
 * --orchestrator, which runs the lifecycle for every selected case (only enabled
 * provider/harness pairs work). --templates-skills requires goldenId; optional
 * publicSkill/privateSkill exact pins enable install checks. No provider credentials or DB access.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_FAILURE_STATUS, type ApiFailureCode } from "../packages/core/src/api-failure.ts";
import type {
  OrchestratorDetail,
  OrchestratorEventPage,
  OrchestratorOperation,
} from "../packages/core/src/orchestrator.ts";
import { runTemplateSkillCase, TemplateSkillSmokeFailure } from "./template-skill-smoke.ts";

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
  | "poll_limit_exceeded"
  | "turn_failed"
  | "exec_failed"
  | "invalid_receipt"
  | "provider_not_stopped"
  | "pair_disabled"
  | "orchestrator_disabled"
  | "operation_failed"
  | "continuity_failed"
  | "preservation_failed"
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
  "conflict",
  "unavailable",
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
  harness: "claude" | "codex";
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
export async function postDeploySmoke(env: NodeJS.ProcessEnv, args: readonly string[], io: SmokeIo): Promise<boolean> {
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
                error instanceof SmokeFailure || error instanceof TemplateSkillSmokeFailure
                  ? error.code
                  : "invalid_response",
              ...(error instanceof TemplateSkillSmokeFailure ? error.details : {}),
            }),
      }),
    );
  }
  let origin: string;
  let cases: SmokeCase[];
  const orchestrator = args.includes("--orchestrator");
  const github = args.includes("--github-runtime");
  const preservation = args.includes("--work-preservation");
  const templatesSkills = args.includes("--templates-skills");
  const lifecycle = args.includes("--lifecycle");
  try {
    if (env.ARMADA_SMOKE !== "create_real_compute") fail("compute_opt_in_required");
    if (
      (github && (orchestrator || preservation || templatesSkills || lifecycle)) ||
      args.some(
        (arg) =>
          arg !== "--orchestrator" &&
          arg !== "--github-runtime" &&
          arg !== "--work-preservation" &&
          arg !== "--templates-skills" &&
          arg !== "--lifecycle",
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
    if ((preservation || templatesSkills || lifecycle) && origin !== "https://armada-mcp-staging.up.railway.app")
      fail("invalid_configuration");
    const parsed: unknown = JSON.parse(env.ARMADA_SMOKE_CASES);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) fail("invalid_configuration");
    for (const item of parsed) {
      if (
        !item ||
        typeof item !== "object" ||
        (item.provider !== "boat" && item.provider !== "modal") ||
        (item.harness !== "claude" && item.harness !== "codex") ||
        ["org", "golden", "model", "modelAccountId", "repo"].some(
          (key) => typeof item[key] !== "string" || !item[key].trim(),
        ) ||
        !item.repo.startsWith("/") ||
        (item.reasoningEffort !== undefined &&
          (typeof item.reasoningEffort !== "string" || !item.reasoningEffort.trim())) ||
        (orchestrator && (typeof item.goldenId !== "string" || !item.goldenId.trim()))
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
    cases = parsed;
  } catch (error) {
    report(0, "configure", error instanceof SmokeFailure ? error : new SmokeFailure("invalid_configuration"));
    return false;
  }
  // Reserve the final five minutes for best-effort cleanup, independently of a failed step.
  const deadline = io.now() + 35 * 60_000;
  const cleanupDeadline = deadline + 5 * 60_000;
  let cleaning = false;
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
      if (error instanceof SmokeFailure) throw error;
      fail("request_failed");
    }
  }
  async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    for (let i = 0; i < POLLS; i++) {
      const value = await read();
      if (done(value)) return value;
      if (i + 1 < POLLS) await io.sleep(1000);
    }
    fail("poll_limit_exceeded");
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
    if (!preservation && !lifecycle) return templateSkillsPassed;
  }
  // Validate the entire selected matrix before any billable mutation. A later
  // disabled case must not be discovered after earlier cases have allocated.
  if (orchestrator) {
    let index = 0;
    try {
      const capabilities = await request<{
        version: number;
        enabled: boolean;
        pairs?: { provider: string; harness: string; enabled: boolean }[];
      }>("orchestrators/capabilities");
      if (capabilities?.version !== 1) fail("invalid_response");
      if (capabilities.enabled !== true) fail("orchestrator_disabled");
      if (!Array.isArray(capabilities.pairs)) fail("invalid_response");
      for (const [caseIndex, item] of cases.entries()) {
        index = caseIndex;
        if (
          !capabilities.pairs.some(
            (pair) => pair?.provider === item.provider && pair.harness === item.harness && pair.enabled === true,
          )
        )
          fail("pair_disabled");
        report(index, "orchestrator_capabilities");
      }
    } catch (error) {
      report(index, "orchestrator_capabilities", error);
      return false;
    }
  }
  let passed = templateSkillsPassed;
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
    let sandboxId: string | undefined;
    let commit: string | undefined;
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
      await step("launch", async () => {
        launchAttempted = true;
        const result = await sandbox<{ sandbox: { id: string; provider: string }; promptId?: string }>(
          "launch",
          {
            golden: item.golden,
            provider: item.provider,
            harness: item.harness,
            model: item.model,
            credentialId: item.modelAccountId,
            ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
            connections: [],
            ttlSeconds: 1800,
          },
          600_000,
        );
        // Retain the cleanup handle even if later response validation fails.
        if (typeof result?.sandbox?.id === "string" && result.sandbox.id) sandboxId = result.sandbox.id;
        if (!sandboxId || result.sandbox.provider !== item.provider || result.promptId) fail("invalid_response");
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
            command: `${git} -c user.name=Armada-Smoke -c user.email=smoke@example.invalid -c core.hooksPath=/dev/null -c commit.gpgsign=false commit --allow-empty -m armada-preservation-smoke >/dev/null && ${git} rev-parse HEAD`,
            timeout_seconds: 60,
          });
          if (result?.exitCode !== 0 || result.timedOut !== false || !/^[a-f0-9]{40}\n?$/.test(result.stdout))
            fail("invalid_receipt");
          commit = result.stdout.trim();
        });
      if (!github) await step("stop", stopSandbox);
      if (preservation)
        await step(dirty ? "preservation_archive" : "preservation_clean_stop", async () => {
          const result = await sandbox<{ archive: string | null }>("recovery", { id: sandboxId });
          if (!dirty) {
            if (preservationNote || result.archive !== null) fail("preservation_failed");
          } else {
            if (
              !commit ||
              typeof result.archive !== "string" ||
              !preservationNote?.startsWith("unpushed work preserved at work_recovery:")
            )
              fail("preservation_failed");
            await verifyRecovery(result.archive, item.repo, commit);
          }
        });
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
    if (!orchestrator || dirty) continue;
    let orchestratorId: string | undefined;
    let orchestratorStopped = false;
    let createAttempted = false;
    const root = "orchestrators";
    const runId = crypto.randomUUID();
    const detail = () =>
      request<OrchestratorDetail>(
        `${root}/${encodeURIComponent(orchestratorId ?? "")}?${new URLSearchParams({ orgId: item.org })}`,
      );
    async function settle(operation: OrchestratorOperation, state: "ready" | "stopped") {
      if (operation?.version !== 1 || !operation.id || operation.orchestratorId !== orchestratorId)
        fail("invalid_response");
      if (operation.state === "failed" || operation.state === "uncertain") fail("operation_failed");
      return poll(detail, (current) => {
        if (current?.version !== 1 || !Array.isArray(current.operations)) fail("invalid_response");
        const receipt = current.operations.find((entry) => entry.id === operation.id);
        if (receipt?.state === "failed" || receipt?.state === "uncertain" || current.orchestrator.state === "blocked")
          fail("operation_failed");
        return receipt?.state === "succeeded" && current.orchestrator.state === state;
      });
    }
    async function mutate(action: "message" | "stop" | "resume") {
      const current = await detail();
      if (current?.version !== 1 || !Number.isSafeInteger(current.orchestrator?.revision)) fail("invalid_response");
      // Dispatch once: never replay an uncertain send/resume with a fresh key.
      if (action === "resume") orchestratorStopped = false;
      return request<OrchestratorOperation>(
        `${root}/${encodeURIComponent(orchestratorId ?? "")}/${action}`,
        {
          orgId: item.org,
          expectedRevision: current.orchestrator.revision,
          ...(action === "message" ? { text: PROMPT } : {}),
        },
        `${runId}-${crypto.randomUUID()}`,
      );
    }
    async function stopOrchestrator() {
      await settle(await mutate("stop"), "stopped");
      orchestratorStopped = true;
    }
    try {
      await step("orchestrator_create", async () => {
        createAttempted = true;
        const operation = await request<OrchestratorOperation>(
          root,
          {
            version: 1,
            orgId: item.org,
            name: `post-deploy-smoke-${runId}`,
            goldenId: item.goldenId,
            idleSeconds: 900,
            provider: item.provider,
            harness: item.harness,
            model: item.model,
            modelAccountId: item.modelAccountId,
            ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
          },
          `${runId}-create`,
        );
        if (typeof operation?.orchestratorId === "string" && operation.orchestratorId)
          orchestratorId = operation.orchestratorId;
        await settle(operation, "ready");
      });
      await step("orchestrator_send", async () => {
        await settle(await mutate("message"), "ready");
        let cursor: string | null = null;
        let finished = false;
        await poll(
          async () => {
            const page = await request<OrchestratorEventPage>(
              `${root}/${encodeURIComponent(orchestratorId ?? "")}/events?${new URLSearchParams({ orgId: item.org, ...(cursor ? { cursor } : {}) })}`,
            );
            if (page?.version !== 1 || !Array.isArray(page.events) || typeof page.hasMore !== "boolean")
              fail("invalid_response");
            for (const entry of page.events) {
              if (entry.kind !== "agent" || entry.event.kind !== "prompt") continue;
              if (entry.event.status === "failed" || entry.event.status === "interrupted") fail("turn_failed");
              if (entry.event.status === "finished") finished = true;
            }
            if (page.hasMore && (!page.cursor || page.cursor === cursor)) fail("invalid_response");
            cursor = page.cursor ?? cursor;
            return finished && !page.hasMore;
          },
          (done) => done,
        );
      });
      await step("orchestrator_stop", stopOrchestrator);
      await step("orchestrator_resume", async () => {
        const before = (await detail()).orchestrator;
        const after = (await settle(await mutate("resume"), "ready")).orchestrator;
        if (
          !before.conversationId ||
          after.conversationId !== before.conversationId ||
          after.sandboxId !== before.sandboxId ||
          after.continuity !== "native"
        )
          fail("continuity_failed");
      });
      await step("orchestrator_stop_final", stopOrchestrator);
    } catch {
      passed = false;
    } finally {
      if (!orchestratorId && createAttempted) {
        // A lost create response is not permission to allocate again. Discover the
        // unique run name using the read-only API, then clean up that handle.
        cleaning = true;
        try {
          await step("reconcile_orchestrator", async () => {
            let cursor: string | null = null;
            const seen = new Set<string>();
            for (let page = 0; page < POLLS; page++) {
              const list: {
                version: number;
                items: { id: string; configuration: { name: string } }[];
                cursor: string | null;
              } = await request(
                `${root}?${new URLSearchParams({ orgId: item.org, limit: "100", ...(cursor ? { cursor } : {}) })}`,
              );
              if (
                list?.version !== 1 ||
                !Array.isArray(list.items) ||
                (list.cursor !== null && typeof list.cursor !== "string")
              )
                fail("invalid_response");
              const found = list.items.find((entry) => entry.configuration.name === `post-deploy-smoke-${runId}`);
              if (found?.id) {
                orchestratorId = found.id;
                return;
              }
              if (list.cursor === null) fail("not_found");
              if (!list.cursor || seen.has(list.cursor)) fail("invalid_response");
              seen.add(list.cursor);
              cursor = list.cursor;
            }
            fail("poll_limit_exceeded");
          });
        } catch {
          passed = false;
        } finally {
          cleaning = false;
        }
      }
      if (orchestratorId && !orchestratorStopped) {
        cleaning = true;
        try {
          await step("cleanup_orchestrator", stopOrchestrator);
        } catch {
          passed = false;
        } finally {
          cleaning = false;
        }
      }
    }
  }
  return passed;
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

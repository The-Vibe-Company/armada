/** API-only smoke; ARMADA_SMOKE=create_real_compute explicitly authorizes compute.
 * ARMADA_URL must be an HTTPS origin; ARMADA_TOKEN is the only credential.
 * ARMADA_SMOKE_CASES is a JSON array of {provider, harness, org, golden, model,
 * modelAccountId, repo, goldenId?, reasoningEffort?}. golden is a launch name;
 * repo is an absolute sandbox cwd for exec. goldenId is required with
 * --orchestrator, which runs the lifecycle for every selected case (only enabled
 * provider/harness pairs work). No defaults, provider credentials or DB access.
 */

import { API_FAILURE_STATUS, type ApiFailureCode } from "../packages/core/src/api-failure.ts";
import type {
  OrchestratorDetail,
  OrchestratorEventPage,
  OrchestratorOperation,
} from "../packages/core/src/orchestrator.ts";

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
  | "provider_not_stopped"
  | "pair_disabled"
  | "operation_failed"
  | "continuity_failed";
const API_CODES = new Set<Code>([
  ...(Object.keys(API_FAILURE_STATUS) as ApiFailureCode[]),
  "sandbox_not_ready",
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_request",
  "conflict",
  "unavailable",
]);
class SmokeFailure extends Error {
  constructor(readonly code: Code) {
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
}
interface SmokeIo {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  out: (line: string) => void;
}
const POLLS = 120;
const PROMPT = "Reply with exactly SMOKE_OK and do not use tools.";

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
              code: error instanceof SmokeFailure ? error.code : "invalid_response",
            }),
      }),
    );
  }
  let origin: string;
  let cases: SmokeCase[];
  const orchestrator = args.includes("--orchestrator");
  try {
    if (env.ARMADA_SMOKE !== "create_real_compute") fail("compute_opt_in_required");
    if (args.some((arg) => arg !== "--orchestrator") || !env.ARMADA_URL || !env.ARMADA_TOKEN || !env.ARMADA_SMOKE_CASES)
      fail("invalid_configuration");
    const url = new URL(env.ARMADA_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      fail("invalid_configuration");
    origin = url.origin;
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
        fail(typeof code === "string" && API_CODES.has(code as Code) ? (code as Code) : "api_failed");
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
      if (capabilities?.version !== 1 || !Array.isArray(capabilities.pairs)) fail("invalid_response");
      for (const [caseIndex, item] of cases.entries()) {
        index = caseIndex;
        if (
          capabilities.enabled !== true ||
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
  let passed = true;
  for (const [index, item] of cases.entries()) {
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
    let sandboxId: string | undefined;
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
          return true;
        },
      );
      stopped = true;
    }
    try {
      await step("launch", async () => {
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
      const turn = await step("send", async () => {
        const result = await poll(
          async () => {
            try {
              return await sandbox<{ promptId: string }>("send", { id: sandboxId, prompt: PROMPT });
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
      await step("wait", () =>
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
          if (result?.exitCode !== 0 || result.timedOut !== false) fail("exec_failed");
        });
      }
      await step("stop", stopSandbox);
    } catch {
      passed = false;
    } finally {
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
    if (!orchestrator) continue;
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

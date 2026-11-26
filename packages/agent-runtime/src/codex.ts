import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { codexPlanLimit, planLimitFromMessage, planLimitMessage } from "@armada/core";
import { ChildOwner } from "./children.ts";
import { codexRateLimited, codexRetryDelay } from "./codex-rate-limit.ts";
import { codexResumeUsage } from "./codex-resume-usage.ts";
import type { ReasoningEffort } from "./codex-schema/ReasoningEffort.ts";
import type { LoginAccountParams } from "./codex-schema/v2/LoginAccountParams.ts";
import type { LoginAccountResponse } from "./codex-schema/v2/LoginAccountResponse.ts";
import type { Thread } from "./codex-schema/v2/Thread.ts";
import type { ThreadItem } from "./codex-schema/v2/ThreadItem.ts";
import type { ThreadStartParams } from "./codex-schema/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "./codex-schema/v2/ThreadStartResponse.ts";
import type { TurnCompletedNotification } from "./codex-schema/v2/TurnCompletedNotification.ts";
import type { TurnStartParams } from "./codex-schema/v2/TurnStartParams.ts";
import type { TurnStartResponse } from "./codex-schema/v2/TurnStartResponse.ts";
import { codexEncryptedHistoryRejected, codexTurnFailureCode } from "./codex-turn-error.ts";
import { codexTurnUsage, settleCodexTurnUsage } from "./codex-turn-usage.ts";
import { validateHarnessCwd } from "./cwd.ts";
import { bounded } from "./deadline.ts";
import { HarnessError, nativeHarnessError, RequestRefused } from "./errors.ts";
import type { Driver, DriverContext, DriverResumeContext, Turn } from "./protocol.ts";

function recoverySummary(thread: Thread): string {
  return (thread.turns ?? [])
    .filter((turn) => turn.status === "completed")
    .slice(-4)
    .map((turn) => {
      const request = turn.items.findLast((item) => item.type === "userMessage");
      const reply = turn.items.findLast((item) => item.type === "agentMessage");
      const text = request?.content.findLast((item) => item.type === "text")?.text;
      return [
        text && `User request excerpt: ${text.slice(0, 600)}`,
        reply?.text && `Assistant reply excerpt: ${reply.text.slice(-1200)}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

/** One app-server per prompt isolates credentials, process failure and notifications. */
export class CodexDriver implements Driver {
  private children = new ChildOwner();
  private nativeWriter = false;
  private tokenTotals = new Map<string, Record<string, number>>();
  constructor(
    private options: {
      executable: string;
      cwd: string;
      env: Record<string, string>;
      refreshSecrets?: () => void;
      onStarted?: () => void;
      exclusiveAuth?: boolean;
      subscriptionAccess?: (
        refresh: boolean,
        previousAccessToken?: string,
      ) => Promise<{ accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null }>;
    },
  ) {}
  configureReadableVariables(variables: Record<string, string>): void {
    Object.assign(this.options.env, variables);
  }
  start(c: DriverContext): Turn {
    return this.open(c, false);
  }
  async resumeSession(c: DriverResumeContext): Promise<{ sessionId: string }> {
    // Definite refusal before any native work starts: replaying the same request ID is safe.
    if (!c.sessionId || c.sessionId.length > 256 || !c.request.model || c.signal.aborted)
      throw new RequestRefused("invalid_native_resume");
    let confirmed = false;
    const connection = this.open(
      {
        ...c,
        request: { ...c.request, text: "" },
        emit: () => {},
        session: (id) => {
          if (id !== c.sessionId) throw Error("native_session_identity_changed");
          confirmed = true;
        },
      },
      true,
    );
    await connection.done;
    c.signal.throwIfAborted();
    if (!confirmed) throw Error("native_session_unverified");
    return { sessionId: c.sessionId };
  }
  private open(c: DriverContext, resumeOnly: boolean): Turn {
    const cwd = validateHarnessCwd(c.request.cwd ?? this.options.cwd);
    let previousAccessToken: string | undefined;
    const subscriptionAccess = async (refresh: boolean) => {
      const result = await this.options.subscriptionAccess!(refresh, previousAccessToken);
      previousAccessToken = result.accessToken;
      return result;
    };
    const effort = c.request.reasoningEffort ?? "medium";
    if (!["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort))
      throw new RequestRefused("invalid_effort");
    if (this.options.exclusiveAuth && this.nativeWriter) throw new RequestRefused("native_auth_writer_busy");
    if (this.options.exclusiveAuth) this.nativeWriter = true;
    const child = this.children.spawn(
      this.options.executable,
      ["-c", 'cli_auth_credentials_store="file"', "-c", 'mcp_oauth_credentials_store="file"', "app-server"],
      {
        cwd,
        env: this.options.env,
      },
    );
    let rateLimits: unknown;
    let rateLimitsRevision = 0;
    const pending = new Map<
      number,
      {
        method: string;
        resolve: (x: unknown) => void;
        reject: (e: Error) => void;
        onResult?: (x: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let next = 0;
    let threadId = "",
      turnId = "",
      closed = false,
      stopping = false,
      steering = false;
    const emptyUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    };
    let baseline: Record<string, number> | null = c.sessionId
      ? (this.tokenTotals.get(c.sessionId) ?? null)
      : emptyUsage;
    const resumeUsage: {
      requested: boolean;
      verified: boolean;
      started: boolean;
      seen: boolean;
      candidate: Record<string, number> | null;
      invalid: boolean;
    } = {
      requested: false,
      verified: false,
      started: false,
      seen: false,
      candidate: null,
      invalid: false,
    };
    const adoptResumeUsage = () => {
      if (!resumeUsage.verified || !resumeUsage.seen) return;
      baseline = resumeUsage.candidate;
      if (baseline) this.tokenTotals.set(threadId, { ...baseline });
      else this.tokenTotals.delete(threadId);
    };
    let reportedModel: string | null = null;
    let modelRerouted = false;
    const usage: { latest: Record<string, unknown> | null } = { latest: null };
    const earlyTerminals = new Map<string, TurnCompletedNotification>();
    const terminalTurns = new Set<string>();
    let terminalResolve: ((value: TurnCompletedNotification) => void) | undefined;
    let terminalReject: ((error: Error) => void) | undefined;
    let failure: Error | undefined;
    let lineFailure: Error | undefined;
    const rpc = <T>(
      method: string,
      params: unknown,
      timeoutMs = 30000,
      fatal = true,
      onResult?: (x: unknown) => void,
    ) =>
      new Promise<T>((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new HarnessError("harness_timeout"));
          if (fatal) child.kill("SIGKILL");
        }, timeoutMs);
        pending.set(id, {
          method,
          resolve: (x) => resolve(x as T),
          reject,
          ...(onResult ? { onResult } : {}),
          timer,
        });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    let retryWait: AbortController | undefined;
    const fail = (error: Error) => {
      if (closed) return;
      failure = error;
      closed = true;
      retryWait?.abort();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      pending.clear();
      terminalReject?.(error);
    };
    child.once("error", (error) => fail(new HarnessError("harness_process_lost", undefined, { cause: error })));
    child.once("exit", () => fail(new HarnessError("harness_process_lost")));
    let stderrTail = "";
    let stderrTruncated = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderrTruncated) return;
      stderrTail += chunk;
      if (stderrTail.length > 2048) {
        stderrTruncated = true;
        stderrTail = "";
      }
    });
    let nativeWorkObserved = false;
    const usageTurnIds = new Set<string>();
    const handleLine = (line: string) => {
      if (closed) return;
      try {
        let m: ReturnType<typeof JSON.parse>;
        try {
          m = JSON.parse(line);
        } catch (cause) {
          throw new HarnessError("invalid_harness_protocol", undefined, { cause });
        }
        this.options.refreshSecrets?.();
        if (m.id !== undefined && !m.method) {
          const p = pending.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(m.id);
            if (m.error) p.reject(nativeHarnessError(m.error, p.method));
            else {
              p.onResult?.(m.result);
              p.resolve(m.result);
            }
          }
          return;
        }
        if (m.id !== undefined && m.method === "account/chatgptAuthTokens/refresh" && this.options.subscriptionAccess) {
          void subscriptionAccess(true)
            .then((result) => {
              if (m.params?.previousAccountId && m.params.previousAccountId !== result.chatgptAccountId)
                throw Error("subscription_identity_changed");
              child.stdin.write(`${JSON.stringify({ id: m.id, result })}\n`);
            })
            .catch(() =>
              child.stdin.write(
                `${JSON.stringify({ id: m.id, error: { code: -32603, message: "Subscription renewal unavailable." } })}\n`,
              ),
            );
          return;
        }
        if (m.id !== undefined) {
          child.stdin.write(
            `${JSON.stringify({ id: m.id, error: { code: -32601, message: "Interactive requests are disabled" } })}\n`,
          );
          return;
        }
        // Account limits have no thread ID and must stay outside the public message lane.
        if (m.method === "account/rateLimits/updated") {
          if (
            m.params?.rateLimits &&
            (m.params.rateLimits.limitId == null || m.params.rateLimits.limitId === "codex")
          ) {
            rateLimits = m.params.rateLimits;
            rateLimitsRevision++;
          }
          c.emit({ kind: "other", type: m.method, data: m.params });
          return;
        }
        if (m.method === "thread/tokenUsage/updated" && !resumeUsage.started) {
          // A resumed history snapshot is only a candidate until the RPC confirms this exact thread.
          // Never adopt a post-dispatch update: it can already include this prompt's tokens.
          if (resumeUsage.requested && c.sessionId && m.params?.threadId === c.sessionId) {
            const total = m.params?.tokenUsage?.total;
            const count = (value: unknown): value is number =>
              typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
            const valid =
              !resumeUsage.invalid &&
              total &&
              ["inputTokens", "outputTokens", "cachedInputTokens"].every((key) => count(total[key])) &&
              total.cachedInputTokens <= total.inputTokens &&
              (total.cacheWriteInputTokens === undefined ||
                (count(total.cacheWriteInputTokens) &&
                  total.cachedInputTokens + total.cacheWriteInputTokens <= total.inputTokens)) &&
              (total.reasoningOutputTokens === undefined ||
                (count(total.reasoningOutputTokens) && total.reasoningOutputTokens <= total.outputTokens));
            const monotone =
              valid &&
              (!resumeUsage.candidate ||
                [
                  "inputTokens",
                  "outputTokens",
                  "cachedInputTokens",
                  "cacheWriteInputTokens",
                  "reasoningOutputTokens",
                ].every(
                  (key) =>
                    !count(resumeUsage.candidate?.[key]) ||
                    (count(total[key]) && total[key] >= resumeUsage.candidate![key]!),
                ));
            resumeUsage.seen = true;
            resumeUsage.invalid = !monotone;
            resumeUsage.candidate = monotone ? { ...total } : null;
            adoptResumeUsage();
          }
          return;
        }
        if (m.params?.threadId !== threadId) return;
        if (
          resumeUsage.started &&
          (m.method === "hook/started" || (m.method.startsWith("item/") && m.params.item?.type !== "userMessage"))
        )
          nativeWorkObserved = true;
        if (m.method === "model/rerouted") {
          // Totals cannot allocate tokens between models, including pre-steer native turns.
          // Invalidate the whole prompt rather than attributing it all to either model.
          modelRerouted = true;
          c.emit({ kind: "other", type: m.method, data: m.params });
          return;
        }
        if (m.method === "thread/tokenUsage/updated") {
          const total = m.params?.tokenUsage?.total;
          const delta = codexTurnUsage(total, baseline);
          if (delta) {
            if (
              typeof m.params.turnId === "string" &&
              (delta.inputTokens !== 0 ||
                delta.outputTokens !== 0 ||
                delta.cachedTokens !== 0 ||
                Object.values(delta).some((value) => typeof value === "number" && value > 0))
            )
              usageTurnIds.add(m.params.turnId);
            usage.latest = delta;
            this.tokenTotals.set(threadId, { ...total });
          }
          return;
        }
        if (m.method === "turn/completed") {
          const terminal = m.params as TurnCompletedNotification;
          const info = terminal.turn?.error?.codexErrorInfo;
          const code =
            typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
          if ((code === "usageLimitExceeded" || code === "rateLimitExceeded") && terminal.turn.error) {
            const limit = codexPlanLimit(
              rateLimits,
              code === "rateLimitExceeded" ? "rate_limited" : "usage_limit_exceeded",
            );
            terminal.turn.error = {
              message: planLimitMessage(limit),
              codexErrorInfo: code,
              additionalDetails: null,
              misalignment: null,
            };
            c.emit({
              kind: "other",
              type: m.method,
              data: {
                threadId: terminal.threadId,
                turn: { id: terminal.turn.id, status: terminal.turn.status, error: terminal.turn.error },
              },
            });
          } else c.emit({ kind: "other", type: m.method, data: m.params, rawDiagnostic: true });
          if (
            typeof terminal.turn?.id !== "string" ||
            !["completed", "interrupted", "failed"].includes(terminal.turn.status)
          )
            throw new HarnessError("invalid_harness_protocol");
          terminalTurns.add(terminal.turn.id);
          if (!turnId) {
            if (earlyTerminals.size >= 16) throw new HarnessError("invalid_harness_protocol");
            earlyTerminals.set(terminal.turn.id, terminal);
          } else if (terminal.turn.id === turnId) terminalResolve?.(terminal);
          return;
        }
        if (m.method === "item/agentMessage/delta")
          c.emit({
            kind: "message",
            text: m.params.delta,
            partial: true,
            tools: [],
            messageId: m.params.itemId,
            textMode: "delta",
          });
        else if (m.method === "item/started" || m.method === "item/completed") {
          const item = m.params.item as ThreadItem;
          const complete = m.method === "item/completed";
          if (item.type === "agentMessage" && complete)
            c.emit({
              kind: "message",
              text: item.text,
              partial: false,
              tools: [],
              messageId: item.id,
              textMode: "snapshot",
            });
          else if (item.type === "commandExecution")
            c.emit({
              kind: "message",
              text: "",
              partial: false,
              tools: [
                {
                  id: item.id,
                  name: "commandExecution",
                  input: { command: item.command, cwd: item.cwd },
                  ...(complete ? { result: { output: item.aggregatedOutput, isError: item.exitCode !== 0 } } : {}),
                },
              ],
            });
          else if (item.type === "mcpToolCall")
            c.emit({
              kind: "message",
              text: "",
              partial: false,
              tools: [
                {
                  id: item.id,
                  name: item.tool,
                  server: item.server,
                  input: item.arguments,
                  ...(complete ? { result: { output: item.result ?? item.error, isError: item.error !== null } } : {}),
                },
              ],
            });
          else c.emit({ kind: "other", type: m.method, data: m.params, rawDiagnostic: true });
        } else c.emit({ kind: "other", type: m.method, data: m.params, rawDiagnostic: true });
      } catch (error) {
        lineFailure = error instanceof Error ? error : new Error("codex_line_handler_failed", { cause: error });
        fail(lineFailure);
        child.kill("SIGKILL");
      }
    };
    let remainder = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (closed) return;
      const lines = (remainder + chunk).split("\n");
      remainder = lines.pop()!;
      for (const line of lines) handleLine(line);
    });
    child.stdout.once("end", () => {
      if (remainder) handleLine(remainder);
    });
    child.stdout.once("error", (error) => {
      fail(new HarnessError("harness_process_lost", undefined, { cause: error }));
      child.kill("SIGKILL");
    });
    let nativeTurnsStarted = 0;
    const begin = async (text: string) => {
      c.signal.throwIfAborted();
      turnId = "";
      const terminal = new Promise<TurnCompletedNotification>((resolve, reject) => {
        terminalResolve = resolve;
        terminalReject = reject;
      });
      void terminal.catch(() => {});
      const params: TurnStartParams = {
        threadId,
        cwd,
        input: [{ type: "text", text, text_elements: [] }],
        ...(reportedModel ? { model: reportedModel } : {}),
        effort: effort as ReasoningEffort,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        ...(c.request.fast ? { serviceTier: "fast" } : {}),
      };
      resumeUsage.started = true;
      nativeTurnsStarted++;
      // Once work can run, an earlier snapshot is not a safe baseline for a later prompt.
      this.tokenTotals.delete(threadId);
      const result = await rpc<TurnStartResponse>("turn/start", params);
      if (typeof result.turn?.id !== "string") throw new HarnessError("invalid_harness_protocol");
      turnId = result.turn.id;
      const early = earlyTerminals.get(turnId);
      earlyTerminals.clear();
      if (early) terminalResolve?.(early);
      return { terminal };
    };
    let current!: Promise<{ terminal: Promise<TurnCompletedNotification> }>;
    const config: ThreadStartParams = {
      cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ...(c.request.model ? { model: c.request.model } : {}),
      ...(c.mcp
        ? {
            config: {
              mcp_servers: Object.fromEntries(
                Object.entries(c.mcp.servers).map(([name, v]) => [
                  name,
                  v.type === "http"
                    ? { url: v.url, http_headers: v.headers ?? {} }
                    : { command: v.command, args: v.args ?? [], env: v.env ?? {} },
                ]),
              ),
            },
          }
        : {}),
    };
    let historySummary = "";
    let recovering = false;
    const initialized = (async () => {
      const initialAccess = this.options.subscriptionAccess ? subscriptionAccess(false) : undefined;
      void initialAccess?.catch(() => {});
      await rpc("initialize", {
        clientInfo: { name: "armada-runner", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      // Handshake proves an actual app-server, not merely a spawned process.
      try {
        this.options.onStarted?.();
      } catch {
        /* Observability is best effort. */
      }
      if (initialAccess) {
        const access = await initialAccess;
        const result = await rpc<LoginAccountResponse>("account/login/start", {
          type: "chatgptAuthTokens",
          ...access,
        } satisfies LoginAccountParams);
        if (result.type !== "chatgptAuthTokens") throw new HarnessError("authentication_failed");
      }
      // Official API-key login uses the private JSONL channel, never argv or an auth-file read.
      if (this.options.env.OPENAI_API_KEY && !this.options.env.ARMADA_CUSTOM_CODEX_ENDPOINT) {
        const login: LoginAccountParams = { type: "apiKey", apiKey: this.options.env.OPENAI_API_KEY };
        const result = await rpc<LoginAccountResponse>("account/login/start", login);
        if (result.type !== "apiKey") throw new HarnessError("authentication_failed");
      }
      resumeUsage.requested = Boolean(c.sessionId);
      const result = await rpc<ThreadStartResponse>(
        c.sessionId ? "thread/resume" : "thread/start",
        c.sessionId ? { ...config, threadId: c.sessionId } : config,
      );
      if (typeof result.thread?.id !== "string") throw new HarnessError("invalid_harness_protocol");
      if (resumeOnly && result.model !== c.request.model) throw Error("native_session_model_changed");
      reportedModel = typeof result.model === "string" && result.model.trim() ? result.model : null;
      threadId = result.thread.id;
      if (c.sessionId && threadId !== c.sessionId) throw Error("native_session_identity_changed");
      c.session(threadId);
      if (c.sessionId && !resumeOnly) historySummary = recoverySummary(result.thread);
      resumeUsage.verified = true;
      adoptResumeUsage();
      if (c.sessionId && !baseline && !resumeUsage.invalid) {
        const persisted = await codexResumeUsage(result.thread.path, threadId);
        // Notifications can arrive while disk I/O is pending. They retain precedence,
        // including an invalidated candidate; never resurrect an invalid baseline.
        if (!resumeUsage.seen && !resumeUsage.invalid) baseline = persisted;
      }
      if (!resumeOnly && !this.options.env.OPENAI_API_KEY && this.options.env.CODEX_HOME) {
        // Existing native ChatGPT session only: pipeline without blocking turn/start.
        // Optional quota failure cannot turn a normal coding request into a harness failure.
        const requestedAtRevision = rateLimitsRevision;
        void rpc<unknown>("account/rateLimits/read", {}, 5000, false, (limits) => {
          if (closed || limits === undefined) return;
          const snapshot =
            limits && typeof limits === "object" && !Array.isArray(limits)
              ? (limits as { rateLimits?: unknown }).rateLimits
              : undefined;
          if (
            requestedAtRevision === rateLimitsRevision &&
            snapshot &&
            typeof snapshot === "object" &&
            !Array.isArray(snapshot) &&
            ((snapshot as { limitId?: unknown }).limitId == null ||
              (snapshot as { limitId?: unknown }).limitId === "codex")
          )
            rateLimits = snapshot;
          c.emit({ kind: "other", type: "account/rateLimits/read", data: limits });
        }).catch(() => {});
      }
      if (failure) throw failure;
    })();
    if (!resumeOnly) current = initialized.then(() => begin(c.request.text));
    const interrupt = async () => {
      stopping = true;
      retryWait?.abort();
      await initialized;
      if (resumeOnly) {
        await this.children.release(child);
        return;
      }
      const active = await current;
      if (!terminalTurns.has(turnId)) await rpc("turn/interrupt", { threadId, turnId });
      try {
        await bounded(active.terminal, 10000);
      } catch (error) {
        await this.children.release(child);
        throw error;
      }
    };
    const abort = () => {
      void interrupt().catch(() => {});
    };
    c.signal.addEventListener("abort", abort, { once: true });
    let steerFinished: Promise<void> = Promise.resolve();
    let retryCount = 0;
    let totalWaitMs = 0;
    const emitDiagnostics = (turnFailed: boolean, snapshot: ReturnType<typeof settleCodexTurnUsage>) => {
      try {
        if (snapshot) c.emit({ kind: "other", type: "armada/turnUsage", data: snapshot });
        if (turnFailed || child.exitCode || child.signalCode || stderrTail || stderrTruncated) {
          if (stderrTail) this.options.refreshSecrets?.();
          c.emit({
            kind: "other",
            type: "harness_stderr",
            data: {
              exitCode: child.exitCode,
              signal: child.signalCode,
              ...(stderrTruncated ? {} : { text: stderrTail }),
              truncated: stderrTruncated,
            },
          });
        }
      } catch (error) {
        if (!turnFailed) throw error;
      }
    };
    const done = (async () => {
      let turnFailed = false;
      try {
        if (resumeOnly) {
          await initialized;
          return "finished" as const;
        }
        for (;;) {
          const active: Promise<{ terminal: Promise<TurnCompletedNotification> }> = current;
          const { terminal } = await active;
          const result = await terminal;
          if (lineFailure) throw lineFailure;
          if (steering) {
            await steerFinished;
            continue;
          }
          if (active !== current) continue;
          if (result.turn.status === "completed" && !result.turn.error) {
            if (c.sessionId && threadId !== c.sessionId) {
              recovering = true;
              const { thread } = await rpc<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
              const rollout = thread?.id === threadId && thread.path ? await stat(thread.path).catch(() => null) : null;
              if (!rollout?.isFile() || !rollout.size) throw new HarnessError("session_restore_failed");
              c.session(threadId, c.sessionId);
            }
            return "finished" as const;
          }
          if (result.turn.status === "interrupted" && stopping && !result.turn.error) return "interrupted" as const;
          // Only retry after a terminal: app-server owns all in-flight retries.
          // Continue the same thread; never replay the original prompt/tools.
          if (!stopping && codexRateLimited(result.turn.error?.codexErrorInfo)) {
            const delayMs = codexRetryDelay(retryCount++);
            totalWaitMs += delayMs;
            c.emit({
              kind: "other",
              type: "armada/modelRateLimit",
              data: {
                retryCount,
                delayMs,
                totalWaitMs,
                message: `Rate limited by the model provider, retrying in ${Math.ceil(delayMs / 1000)} s`,
              },
            });
            retryWait = new AbortController();
            if (stopping || c.signal.aborted) return "interrupted" as const;
            try {
              await sleep(delayMs, undefined, { signal: retryWait.signal });
            } catch (error) {
              if (!retryWait.signal.aborted) throw error;
            } finally {
              retryWait = undefined;
            }
            if (stopping || c.signal.aborted) return "interrupted" as const;
            if (failure) throw failure;
            if (active !== current) continue;
            current = begin(
              "Continue from where the model provider request was rate limited. Do not repeat completed work.",
            );
            continue;
          }
          const info = result.turn.error?.codexErrorInfo;
          const code =
            typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
          if (
            c.sessionId === threadId &&
            nativeTurnsStarted === 1 &&
            !nativeWorkObserved &&
            !usageTurnIds.has(turnId) &&
            !stopping &&
            !c.signal.aborted &&
            result.turn.status === "failed" &&
            (code === "badRequest" || code === "other") &&
            codexEncryptedHistoryRejected(result.turn.error?.message)
          ) {
            recovering = true;
            const replacement = await rpc<ThreadStartResponse>("thread/start", config);
            if (stopping || c.signal.aborted) return "interrupted" as const;
            const replacementId = replacement.thread?.id;
            if (typeof replacementId !== "string" || !replacementId || replacementId === threadId)
              throw new HarnessError("invalid_harness_protocol");
            this.tokenTotals.delete(threadId);
            threadId = replacementId;
            turnId = "";
            baseline = emptyUsage;
            usage.latest = null;
            reportedModel =
              typeof replacement.model === "string" && replacement.model.trim() ? replacement.model : null;
            modelRerouted = false;
            c.emit({
              kind: "other",
              type: "armada/codexThreadRecovery",
              data: { reason: "invalid_encrypted_content" },
            });
            if (stopping || c.signal.aborted) return "interrupted" as const;
            current = begin(
              [
                "Codex could not restore the previous thread. Continue the current request below.",
                "Inspect the workspace and verify what already happened before acting. Avoid repeating completed actions.",
                historySummary && `Prior conversation excerpts for context only:\n${historySummary}`,
                `Current request:\n${c.request.text}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            );
            recovering = false;
            continue;
          }
          if (code === "usageLimitExceeded" || code === "rateLimitExceeded")
            c.emit({
              kind: "other",
              type: "usage_limit",
              data:
                planLimitFromMessage(result.turn.error?.message) ??
                codexPlanLimit(undefined, code === "rateLimitExceeded" ? "rate_limited" : "usage_limit_exceeded"),
            });
          // A response cut by the model's output limit is reported by pinned Codex as a
          // generic `other` terminal with the exact Display text below; name that cause
          // instead of collapsing it into a configuration failure.
          throw new HarnessError(codexTurnFailureCode(code, result.turn.error?.message));
        }
      } catch (error) {
        turnFailed = true;
        throw error;
      } finally {
        closed = true;
        for (const p of pending.values()) clearTimeout(p.timer);
        pending.clear();
        const snapshot = settleCodexTurnUsage({
          tokenTotals: this.tokenTotals,
          threadId,
          dispatched: resumeUsage.started,
          terminalObserved: terminalTurns.has(turnId),
          latest: usage.latest,
          model: modelRerouted ? null : reportedModel,
        });
        await this.children.release(child);
        this.nativeWriter = false;
        c.signal.removeEventListener("abort", abort);
        emitDiagnostics(turnFailed, snapshot);
      }
    })();
    return {
      done,
      interrupt,
      steer: async (text) => {
        // Definite pre-side-effect refusal: no continuation has begun, so a retry is safe.
        if (resumeOnly || closed || steering || stopping || recovering) throw new RequestRefused("no_running_turn");
        steering = true;
        steerFinished = (async () => {
          try {
            const active = await current;
            if (!terminalTurns.has(turnId)) await rpc("turn/interrupt", { threadId, turnId });
            try {
              await bounded(active.terminal, 10000);
            } catch (error) {
              await this.children.release(child);
              throw error;
            }
            current = begin(text);
            retryWait?.abort();
            await current;
          } finally {
            steering = false;
          }
        })();
        await steerFinished;
      },
    };
  }
  async close() {
    await this.children.close();
  }
}

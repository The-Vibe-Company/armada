import { createInterface } from "node:readline";
import { codexPlanLimit, planLimitFromMessage, planLimitMessage } from "@armada/core";
import { ChildOwner } from "./children.ts";
import type { ReasoningEffort } from "./codex-schema/ReasoningEffort.ts";
import type { LoginAccountParams } from "./codex-schema/v2/LoginAccountParams.ts";
import type { LoginAccountResponse } from "./codex-schema/v2/LoginAccountResponse.ts";
import type { ThreadItem } from "./codex-schema/v2/ThreadItem.ts";
import type { ThreadStartParams } from "./codex-schema/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "./codex-schema/v2/ThreadStartResponse.ts";
import type { TurnCompletedNotification } from "./codex-schema/v2/TurnCompletedNotification.ts";
import type { TurnStartParams } from "./codex-schema/v2/TurnStartParams.ts";
import type { TurnStartResponse } from "./codex-schema/v2/TurnStartResponse.ts";
import { validateHarnessCwd } from "./cwd.ts";
import { bounded } from "./deadline.ts";
import { HarnessError } from "./errors.ts";
import type { Driver, DriverContext, DriverResumeContext, Turn } from "./protocol.ts";
/** One app-server per conversation isolates credentials, process failure and notifications. */
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
    if (!c.sessionId || c.sessionId.length > 256 || !c.request.model || c.signal.aborted)
      throw Error("invalid_native_resume");
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
      throw Error("invalid_effort");
    if (this.options.exclusiveAuth && this.nativeWriter) throw Error("native_auth_writer_busy");
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
      { resolve: (x: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
    >();
    let next = 0;
    let threadId = "",
      turnId = "",
      closed = false,
      stopping = false,
      steering = false;
    const baseline: Record<string, number> | null = c.sessionId
      ? (this.tokenTotals.get(c.sessionId) ?? null)
      : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 };
    const earlyTerminals = new Map<string, TurnCompletedNotification>();
    let terminalResolve: ((value: TurnCompletedNotification) => void) | undefined;
    let terminalReject: ((error: Error) => void) | undefined;
    const lines = createInterface({ input: child.stdout });
    const rpc = <T>(method: string, params: unknown, timeoutMs = 30000, fatal = true): Promise<T> =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new HarnessError("harness_timeout"));
          if (fatal) child.kill("SIGKILL");
        }, timeoutMs);
        pending.set(id, { resolve: (x) => resolve(x as T), reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    const fail = () => {
      closed = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new HarnessError("harness_process_lost"));
      }
      pending.clear();
      terminalReject?.(new HarnessError("harness_process_lost"));
    };
    child.once("error", fail);
    child.once("exit", fail);
    child.stderr.resume();
    lines.on("line", (line) => {
      try {
        const m = JSON.parse(line);
        this.options.refreshSecrets?.();
        if (m.id !== undefined && !m.method) {
          const p = pending.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(m.id);
            if (m.error) p.reject(Error("codex_rpc_error"));
            else p.resolve(m.result);
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
        if (m.params?.threadId !== threadId) return;
        if (m.method === "thread/tokenUsage/updated") {
          const total = m.params?.tokenUsage?.total;
          if (
            total &&
            ["inputTokens", "outputTokens", "cachedInputTokens"].every(
              (key) => Number.isSafeInteger(total[key]) && total[key] >= 0,
            )
          ) {
            const delta = (key: string) =>
              baseline &&
              Number.isSafeInteger(total[key]) &&
              Number.isSafeInteger(baseline[key]) &&
              total[key] >= baseline[key]!
                ? total[key] - baseline[key]!
                : null;
            c.emit({
              kind: "other",
              type: "armada/turnUsage",
              data: {
                model: c.request.model ?? "gpt-6.1-sol",
                inputTokens: delta("inputTokens"),
                outputTokens: delta("outputTokens"),
                cachedTokens: delta("cachedInputTokens"),
                ...(Number.isSafeInteger(total.cacheWriteInputTokens)
                  ? { cacheWriteTokens: delta("cacheWriteInputTokens") }
                  : {}),
                ...(Number.isSafeInteger(total.reasoningOutputTokens)
                  ? { reasoningTokens: delta("reasoningOutputTokens") }
                  : {}),
              },
            });
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
          } else c.emit({ kind: "other", type: m.method, data: m.params });
          if (
            typeof terminal.turn?.id !== "string" ||
            !["completed", "interrupted", "failed"].includes(terminal.turn.status)
          )
            throw new HarnessError("invalid_harness_protocol");
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
                  input: item.arguments,
                  ...(complete ? { result: { output: item.result ?? item.error, isError: item.error !== null } } : {}),
                },
              ],
            });
          else c.emit({ kind: "other", type: m.method, data: m.params });
        } else c.emit({ kind: "other", type: m.method, data: m.params });
      } catch {
        fail();
        child.kill("SIGKILL");
      }
    });
    const begin = async (text: string) => {
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
        model: c.request.model ?? "gpt-6.1-sol",
        effort: effort as ReasoningEffort,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        ...(c.request.fast ? { serviceTier: "fast" } : {}),
      };
      const result = await rpc<TurnStartResponse>("turn/start", params);
      if (typeof result.turn?.id !== "string") throw new HarnessError("invalid_harness_protocol");
      turnId = result.turn.id;
      const early = earlyTerminals.get(turnId);
      earlyTerminals.clear();
      if (early) terminalResolve?.(early);
      return { terminal };
    };
    let current!: Promise<{ terminal: Promise<TurnCompletedNotification> }>;
    const initialized = (async () => {
      await rpc("initialize", {
        clientInfo: { name: "armada-runner", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      if (this.options.subscriptionAccess) {
        const access = await subscriptionAccess(false);
        const result = await rpc<LoginAccountResponse>("account/login/start", {
          type: "chatgptAuthTokens",
          ...access,
        } satisfies LoginAccountParams);
        if (result.type !== "chatgptAuthTokens") throw new HarnessError("authentication_failed");
      }
      // Official API-key login uses the private JSONL channel, never argv or an auth-file read.
      if (this.options.env.OPENAI_API_KEY) {
        const login: LoginAccountParams = { type: "apiKey", apiKey: this.options.env.OPENAI_API_KEY };
        const result = await rpc<LoginAccountResponse>("account/login/start", login);
        if (result.type !== "apiKey") throw new HarnessError("authentication_failed");
      }
      const config: ThreadStartParams = {
        cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        model: c.request.model ?? "gpt-6.1-sol",
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
      const result = await rpc<ThreadStartResponse>(
        c.sessionId ? "thread/resume" : "thread/start",
        c.sessionId ? { ...config, threadId: c.sessionId } : config,
      );
      if (typeof result.thread?.id !== "string") throw new HarnessError("invalid_harness_protocol");
      if (resumeOnly && result.model !== c.request.model) throw Error("native_session_model_changed");
      threadId = result.thread.id;
      if (c.sessionId && threadId !== c.sessionId) throw Error("native_session_identity_changed");
      c.session(threadId);
      if (!this.options.env.OPENAI_API_KEY && this.options.env.CODEX_HOME) {
        // Existing native ChatGPT session only: this documented RPC never starts inference.
        // Optional quota failure cannot turn a normal coding request into a harness failure.
        try {
          const requestedAtRevision = rateLimitsRevision;
          const limits = await rpc<unknown>("account/rateLimits/read", {}, 5000, false);
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
        } catch {}
      }
    })();
    if (!resumeOnly) current = initialized.then(() => begin(c.request.text));
    const interrupt = async () => {
      stopping = true;
      await initialized;
      if (resumeOnly) {
        await this.children.release(child);
        return;
      }
      const active = await current;
      await rpc("turn/interrupt", { threadId, turnId });
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
    const done = (async () => {
      try {
        if (resumeOnly) {
          await initialized;
          return "finished" as const;
        }
        for (;;) {
          const active: Promise<{ terminal: Promise<TurnCompletedNotification> }> = current;
          const { terminal } = await active;
          const result = await terminal;
          if (steering) {
            await steerFinished;
            continue;
          }
          if (active !== current) continue;
          if (result.turn.status === "completed" && !result.turn.error) return "finished" as const;
          if (result.turn.status === "interrupted" && stopping && !result.turn.error) return "interrupted" as const;
          const info = result.turn.error?.codexErrorInfo;
          const code =
            typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
          if (code === "usageLimitExceeded" || code === "rateLimitExceeded")
            c.emit({
              kind: "other",
              type: "usage_limit",
              data:
                planLimitFromMessage(result.turn.error?.message) ??
                codexPlanLimit(undefined, code === "rateLimitExceeded" ? "rate_limited" : "usage_limit_exceeded"),
            });
          throw new HarnessError(
            code === "unauthorized"
              ? "authentication_failed"
              : code === "usageLimitExceeded" || code === "sessionBudgetExceeded"
                ? "usage_limit_exceeded"
                : code === "rateLimitExceeded"
                  ? "rate_limited"
                  : code === "contextWindowExceeded"
                    ? "context_window_exceeded"
                    : "harness_failed",
          );
        }
      } finally {
        closed = true;
        lines.close();
        await this.children.release(child);
        this.nativeWriter = false;
        c.signal.removeEventListener("abort", abort);
      }
    })();
    return {
      done,
      interrupt,
      steer: async (text) => {
        if (resumeOnly || closed || steering || stopping) throw Error("no_running_turn");
        steering = true;
        steerFinished = (async () => {
          try {
            const active = await current;
            await rpc("turn/interrupt", { threadId, turnId });
            try {
              await bounded(active.terminal, 10000);
            } catch (error) {
              await this.children.release(child);
              throw error;
            }
            current = begin(text);
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

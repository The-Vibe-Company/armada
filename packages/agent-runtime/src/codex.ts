import { createInterface } from "node:readline";
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
import type { Driver, DriverContext, Turn } from "./protocol.ts";
/** One app-server per conversation isolates credentials, process failure and notifications. */
export class CodexDriver implements Driver {
  private children = new ChildOwner();
  constructor(
    private options: { executable: string; cwd: string; env: Record<string, string>; refreshSecrets?: () => void },
  ) {}
  start(c: DriverContext): Turn {
    const cwd = validateHarnessCwd(c.request.cwd ?? this.options.cwd);
    const effort = c.request.reasoningEffort ?? "medium";
    if (!["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort))
      throw Error("invalid_effort");
    const child = this.children.spawn(
      this.options.executable,
      ["-c", 'cli_auth_credentials_store="file"', "-c", 'mcp_oauth_credentials_store="file"', "app-server"],
      {
        cwd,
        env: this.options.env,
      },
    );
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
    const earlyTerminals = new Map<string, TurnCompletedNotification>();
    let terminalResolve: ((value: TurnCompletedNotification) => void) | undefined;
    let terminalReject: ((error: Error) => void) | undefined;
    const lines = createInterface({ input: child.stdout });
    const rpc = <T>(method: string, params: unknown): Promise<T> =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new HarnessError("harness_timeout"));
          child.kill("SIGKILL");
        }, 30000);
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
        if (m.id !== undefined) {
          child.stdin.write(
            `${JSON.stringify({ id: m.id, error: { code: -32601, message: "Interactive requests are disabled" } })}\n`,
          );
          return;
        }
        if (m.params?.threadId !== threadId) return;
        if (m.method === "turn/completed") {
          c.emit({ kind: "other", type: m.method, data: m.params });
          const terminal = m.params as TurnCompletedNotification;
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
    let current: Promise<{ terminal: Promise<TurnCompletedNotification> }>;
    const initialized = (async () => {
      await rpc("initialize", {
        clientInfo: { name: "armada-runner", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
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
      threadId = result.thread.id;
      c.session(threadId);
    })();
    current = initialized.then(() => begin(c.request.text));
    const interrupt = async () => {
      stopping = true;
      await initialized;
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
        for (;;) {
          const active = current;
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
        c.signal.removeEventListener("abort", abort);
      }
    })();
    return {
      done,
      interrupt,
      steer: async (text) => {
        if (closed || steering || stopping) throw Error("no_running_turn");
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

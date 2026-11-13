import { VERSION } from "@armada/core";
import { ChildOwner } from "./children.ts";
import { validateHarnessCwd } from "./cwd.ts";
import { bounded } from "./deadline.ts";
import { HarnessError } from "./errors.ts";
import type { Driver, DriverContext, DriverResumeContext, Turn } from "./protocol.ts";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** ACP v1 over stdio. One process per turn; session/load preserves the native conversation on subsequent turns. */
export class AcpDriver implements Driver {
  private children = new ChildOwner();
  constructor(private options: { executable: string; cwd: string; env: Record<string, string>; args?: string[] }) {}
  configureReadableVariables(variables: Record<string, string>): void {
    Object.assign(this.options.env, variables);
  }
  start(context: DriverContext): Turn {
    return this.open(context, false);
  }
  async resumeSession(context: DriverResumeContext): Promise<{ sessionId: string }> {
    let verified = false;
    const turn = this.open(
      {
        ...context,
        request: { ...context.request, text: "" },
        emit: () => {},
        session: (id) => {
          if (id !== context.sessionId) throw new HarnessError("invalid_harness_protocol");
          verified = true;
        },
      },
      true,
    );
    await turn.done;
    if (!verified) throw new HarnessError("invalid_harness_protocol");
    return { sessionId: context.sessionId };
  }
  private open(c: DriverContext, resumeOnly: boolean): Turn {
    c.signal.throwIfAborted();
    if (c.request.fast) throw new HarnessError("invalid_harness_protocol");
    if (c.request.reasoningEffort !== undefined && c.request.reasoningEffort !== "default")
      throw new HarnessError("invalid_harness_protocol");
    const cwd = validateHarnessCwd(c.request.cwd ?? this.options.cwd);
    const child = this.children.spawn(this.options.executable, this.options.args ?? ["acp"], {
      cwd,
      env: this.options.env,
    });
    child.stderr.resume(); // Never expose harness diagnostics, which may contain credentials.
    let sequence = 0,
      sessionId = "",
      replay = true,
      stopped = false,
      interrupted = false,
      steering = false;
    const pending = new Map<
      number,
      { resolve(value: ObjectValue): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }
    >();
    const failure = (code: "harness_process_lost" | "invalid_harness_protocol" = "harness_process_lost") => {
      stopped = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new HarnessError(code));
      }
      pending.clear();
    };
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...(value as object) })}\n`);
    const rpc = (method: string, params: unknown, deadline = true): Promise<ObjectValue> =>
      new Promise((resolve, reject) => {
        if (stopped) {
          reject(new HarnessError("harness_process_lost"));
          return;
        }
        const id = ++sequence;
        const entry: typeof pending extends Map<number, infer T> ? T : never = { resolve, reject };
        if (deadline)
          entry.timer = setTimeout(() => {
            pending.delete(id);
            reject(new HarnessError("harness_timeout"));
            child.kill("SIGKILL");
          }, 30_000);
        pending.set(id, entry);
        send({ id, method, params });
      });
    child.once("error", () => failure());
    child.once("exit", () => failure());
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        failure("invalid_harness_protocol");
        child.kill("SIGKILL");
        return;
      }
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end === -1) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const m: unknown = JSON.parse(line);
          if (!object(m) || m.jsonrpc !== "2.0") throw Error();
          if (typeof m.id === "number" && m.method === undefined) {
            const entry = pending.get(m.id);
            if (!entry) continue;
            clearTimeout(entry.timer);
            pending.delete(m.id);
            if (m.error !== undefined || !object(m.result)) entry.reject(new HarnessError("harness_failed"));
            else entry.resolve(m.result);
          } else if (m.id !== undefined && typeof m.method === "string") {
            // ACP tools execute inside the admitted sandbox. Choose only an explicit one-shot allow option.
            const params = object(m.params) ? m.params : {};
            const options = Array.isArray(params.options) ? params.options : [];
            const option = options.find(
              (value) => object(value) && value.kind === "allow_once" && typeof value.optionId === "string",
            );
            if (m.method === "session/request_permission" && params.sessionId === sessionId && object(option))
              send({ id: m.id, result: { outcome: { outcome: "selected", optionId: option.optionId } } });
            else send({ id: m.id, error: { code: -32601, message: "Client operation unavailable" } });
          } else if (
            !replay &&
            m.method === "session/update" &&
            object(m.params) &&
            m.params.sessionId === sessionId &&
            object(m.params.update)
          ) {
            const u = m.params.update;
            if (
              u.sessionUpdate === "agent_message_chunk" &&
              object(u.content) &&
              u.content.type === "text" &&
              typeof u.content.text === "string"
            )
              c.emit({
                kind: "message",
                text: u.content.text,
                partial: true,
                textMode: "delta",
                messageId: `acp-${sequence}-${typeof u.messageId === "string" ? u.messageId : "assistant"}`,
                tools: [],
              });
            if (
              (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
              typeof u.toolCallId === "string"
            )
              c.emit({
                kind: "message",
                text: "",
                partial: false,
                tools: [
                  {
                    id: u.toolCallId,
                    name:
                      typeof u.title === "string"
                        ? u.title
                        : u.sessionUpdate === "tool_call_update"
                          ? "tool_result"
                          : "tool",
                    ...(u.rawInput === undefined ? {} : { input: u.rawInput }),
                    ...(u.status === "completed" || u.status === "failed"
                      ? { result: { output: u.rawOutput ?? u.content ?? null, isError: u.status === "failed" } }
                      : {}),
                  },
                ],
              });
          }
        } catch {
          failure("invalid_harness_protocol");
          child.kill("SIGKILL");
        }
      }
    });
    const cancel = async () => {
      if (sessionId && !stopped) send({ method: "session/cancel", params: { sessionId } });
    };
    const abort = () => {
      interrupted = true;
      void cancel();
      child.kill("SIGKILL");
    };
    c.signal.addEventListener("abort", abort, { once: true });
    if (c.signal.aborted) abort();
    let current: Promise<ObjectValue> | undefined;
    const totals: Record<string, number | null> = {};
    let usageSeen = false;
    const usage = (response: ObjectValue) => {
      const u = object(response.usage) ? response.usage : {};
      const count = (value: unknown): value is number =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
      for (const [key, native] of Object.entries({
        inputTokens: "inputTokens",
        outputTokens: "outputTokens",
        cachedTokens: "cachedReadTokens",
        cacheWriteTokens: "cachedWriteTokens",
        reasoningTokens: "thoughtTokens",
      })) {
        const value = u[native];
        const prior = totals[key];
        const sum = count(value) && prior !== null ? (prior ?? 0) + value : null;
        totals[key] = sum !== null && Number.isSafeInteger(sum) ? sum : null;
      }
      usageSeen = true;
    };
    const begin = (text: string) => rpc("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, false);
    const ready = (async () => {
      const initialized = await rpc("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "armada", version: VERSION },
      });
      if (initialized.protocolVersion !== 1) throw new HarnessError("invalid_harness_protocol");
      const mcpServers = Object.entries(c.mcp?.servers ?? {}).map(([name, server]) =>
        server.type === "stdio"
          ? {
              name,
              command: server.command,
              args: server.args ?? [],
              env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
            }
          : {
              name,
              type: "http",
              url: server.url,
              headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
            },
      );
      if (c.sessionId) {
        if (!object(initialized.agentCapabilities) || initialized.agentCapabilities.loadSession !== true)
          throw new HarnessError("invalid_harness_protocol");
        sessionId = c.sessionId;
        await rpc("session/load", { sessionId, cwd, mcpServers });
      } else {
        const created = await rpc("session/new", { cwd, mcpServers });
        if (typeof created.sessionId !== "string" || !created.sessionId || created.sessionId.length > 256)
          throw new HarnessError("invalid_harness_protocol");
        sessionId = created.sessionId;
      }
      c.session(sessionId);
      if (!resumeOnly && c.request.model) await rpc("session/set_model", { sessionId, modelId: c.request.model });
      replay = false;
    })();
    const done = (async (): Promise<"finished" | "interrupted"> => {
      try {
        await ready;
        if (resumeOnly) return "finished";
        current = begin(c.request.text);
        for (;;) {
          const active: Promise<ObjectValue> = current;
          const response = await active;
          // A restart replaces the running native turn but remains the same Armada prompt.
          if (current !== active) continue;
          usage(response);
          if (response.stopReason === "cancelled") return "interrupted";
          if (response.stopReason !== "end_turn") throw new HarnessError("harness_failed");
          return interrupted ? "interrupted" : "finished";
        }
      } catch (error) {
        for (const key of Object.keys(totals)) totals[key] = null;
        if (c.signal.aborted || interrupted) return "interrupted";
        throw error;
      } finally {
        if (usageSeen)
          c.emit({ kind: "other", type: "armada/turnUsage", data: { model: c.request.model ?? null, ...totals } });
        stopped = true;
        failure();
        c.signal.removeEventListener("abort", abort);
        await this.children.release(child);
      }
    })();
    return {
      done,
      interrupt: async () => {
        interrupted = true;
        await ready;
        await cancel();
        try {
          await bounded(done, 10_000);
        } catch {
          child.kill("SIGKILL");
          await done;
        }
      },
      steer: async (text) => {
        await ready;
        if (!current || stopped || steering) throw Error("no_running_turn");
        steering = true;
        try {
          const previous = current;
          // Install the continuation before cancellation resolves the old request.
          let resolve!: (value: ObjectValue) => void, reject!: (error: unknown) => void;
          current = new Promise<ObjectValue>((yes, no) => {
            resolve = yes;
            reject = no;
          });
          await cancel();
          try {
            usage(await bounded(previous, 10_000));
          } catch (error) {
            failure();
            child.kill("SIGKILL");
            throw error;
          }
          begin(text).then(resolve, reject);
        } finally {
          steering = false;
        }
      },
    };
  }
  async close() {
    await this.children.close();
  }
}

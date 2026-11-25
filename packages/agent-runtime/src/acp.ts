import { VERSION } from "@armada/core";
import { ChildOwner } from "./children.ts";
import { validateHarnessCwd } from "./cwd.ts";
import { bounded } from "./deadline.ts";
import { acpStopReasonCode, HarnessError, nativeHarnessError, RequestRefused } from "./errors.ts";
import { toolCallIdentifier, toolIdentifier } from "./journal.ts";
import type { Driver, DriverContext, DriverResumeContext, Turn } from "./protocol.ts";

const MAX_LONG_TOOL_TITLE_BYTES = 1024 * 1024;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function concreteModel(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed !== "default" ? trimmed : undefined;
}

function currentModel(configOptions: unknown, models?: unknown) {
  if (Array.isArray(configOptions)) {
    const option = configOptions.find((value) => object(value) && value.id === "model");
    const selected = option ? concreteModel(option.currentValue) : undefined;
    if (selected) return selected;
  }
  return object(models) ? concreteModel(models.currentModelId) : undefined;
}

function availableModel(configOptions: unknown, model: string) {
  if (!Array.isArray(configOptions)) return false;
  const option = configOptions.find((value) => object(value) && value.id === "model" && value.type === "select");
  return (
    Array.isArray(option?.options) &&
    option.options.some(
      (value: unknown) =>
        object(value) &&
        (value.value === model ||
          (Array.isArray(value.options) && value.options.some((item) => object(item) && item.value === model))),
    )
  );
}
export interface AcpObservation {
  ready(sessionId: string): Promise<void>;
  failed: Promise<never>;
  close(): Promise<void>;
}

/** ACP v1 over stdio. One process per turn; session/load preserves the native conversation on subsequent turns. */
export class AcpDriver implements Driver {
  private children = new ChildOwner();
  constructor(
    private options: {
      executable: string;
      cwd: string;
      env: Record<string, string>;
      args?: string[];
      redactToolText?(text: string): string;
      observation?: AcpObservation;
      authMethodId?: string;
      authenticationRequiredLine?: string;
      modelSelection?: "config-option";
    },
  ) {}
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
    // Definite refusal before spawn: replayed safely, including from native resume.
    if (c.request.fast) throw new RequestRefused("invalid_harness_protocol");
    if (c.request.reasoningEffort !== undefined && c.request.reasoningEffort !== "default")
      throw new RequestRefused("invalid_harness_protocol");
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
    let activeModel: string | undefined;
    const longToolTitles = new Map<string, { title: string; bytes: number }>();
    let longToolTitleBytes = 0;
    const clearLongToolTitles = () => {
      longToolTitles.clear();
      longToolTitleBytes = 0;
    };
    const releaseLongToolTitle = (id: string) => {
      const existing = longToolTitles.get(id);
      if (!existing) return;
      longToolTitles.delete(id);
      longToolTitleBytes -= existing.bytes;
    };
    const retainLongToolTitle = (id: string, title: string) => {
      const bytes = Buffer.byteLength(id) + Buffer.byteLength(title);
      const previous = longToolTitles.get(id)?.bytes ?? 0;
      const nextBytes = longToolTitleBytes - previous + bytes;
      if (nextBytes > MAX_LONG_TOOL_TITLE_BYTES) throw new HarnessError("invalid_harness_protocol");
      longToolTitles.set(id, { title, bytes });
      longToolTitleBytes = nextBytes;
    };
    const pending = new Map<
      number,
      {
        method: string;
        resolve(value: ObjectValue): void;
        reject(error: Error): void;
        timer?: ReturnType<typeof setTimeout>;
      }
    >();
    const failure = (error = new HarnessError("harness_process_lost")) => {
      stopped = true;
      clearLongToolTitles();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
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
        const entry: typeof pending extends Map<number, infer T> ? T : never = { method, resolve, reject };
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
    let assistantMessageId = "";
    let assistantBytes = 0;
    let assistantChunks: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        failure(new HarnessError("invalid_harness_protocol"));
        child.kill("SIGKILL");
        return;
      }
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end === -1) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        if (
          this.options.authenticationRequiredLine &&
          line.startsWith(this.options.authenticationRequiredLine) &&
          [...pending.values()].some((entry) => entry.method === "authenticate")
        ) {
          failure(new HarnessError("authentication_failed", "authentication"));
          child.kill("SIGKILL");
          return;
        }
        try {
          const m: unknown = JSON.parse(line);
          if (!object(m) || m.jsonrpc !== "2.0") throw Error();
          if (typeof m.id === "number" && m.method === undefined) {
            const entry = pending.get(m.id);
            if (!entry) continue;
            clearTimeout(entry.timer);
            pending.delete(m.id);
            if (m.error !== undefined) entry.reject(nativeHarnessError(m.error, entry.method, "acp"));
            else if (!object(m.result)) entry.reject(new HarnessError("invalid_harness_protocol"));
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
            !stopped &&
            sessionId &&
            m.method === "session/update" &&
            object(m.params) &&
            m.params.sessionId === sessionId &&
            object(m.params.update)
          ) {
            const u = m.params.update;
            if (u.sessionUpdate === "config_option_update") {
              const resolved = currentModel(u.configOptions, u.models);
              if (resolved) activeModel = resolved;
              continue;
            }
            if (replay) continue;
            if (
              u.sessionUpdate === "agent_message_chunk" &&
              object(u.content) &&
              u.content.type === "text" &&
              typeof u.content.text === "string" &&
              assistantMessageId
            ) {
              assistantBytes += Buffer.byteLength(u.content.text);
              if (assistantBytes > 16 * 1024 * 1024) throw new HarnessError("invalid_harness_protocol");
              if (u.content.text) assistantChunks.push(u.content.text);
              c.emit({
                kind: "message",
                text: u.content.text,
                partial: true,
                textMode: "delta",
                messageId: assistantMessageId,
                tools: [],
              });
            }
            if (
              (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
              typeof u.toolCallId === "string"
            ) {
              const title = typeof u.title === "string" ? u.title : "";
              const redact = (text: string) => this.options.redactToolText?.(text) ?? text;
              const redactIdentifier = (text: string) => {
                const scrubbed = redact(text);
                return scrubbed.includes("\0") ? redact(scrubbed.replaceAll("\0", "")) : scrubbed;
              };
              const label = redactIdentifier(title).trim();
              const name = toolIdentifier(label, u.sessionUpdate === "tool_call_update" ? "tool_result" : "tool");
              const id = toolCallIdentifier(redactIdentifier(u.toolCallId));
              const terminal = u.status === "completed" || u.status === "failed";
              const longTitle = label.length > name.length ? redact(title) : undefined;
              const retained = longToolTitles.get(id)?.title;
              if (terminal) releaseLongToolTitle(id);
              else if (longTitle !== undefined) retainLongToolTitle(id, longTitle);
              const command = longTitle ?? (u.rawInput === undefined ? undefined : retained);
              let input = u.rawInput;
              if (command !== undefined) {
                input =
                  input === null || input === undefined || input === title
                    ? command
                    : { title: command, rawInput: input };
              }
              c.emit({
                kind: "message",
                text: "",
                partial: false,
                tools: [
                  {
                    id,
                    name,
                    ...(input === undefined ? {} : { input }),
                    ...(terminal
                      ? { result: { output: u.rawOutput ?? u.content ?? null, isError: u.status === "failed" } }
                      : {}),
                  },
                ],
              });
            }
          }
        } catch {
          failure(new HarnessError("invalid_harness_protocol"));
          child.kill("SIGKILL");
          return;
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
    const begin = (text: string) => {
      assistantChunks = [];
      assistantBytes = 0;
      clearLongToolTitles();
      const response = rpc("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, false);
      assistantMessageId = `acp-${crypto.randomUUID()}-${sequence}-assistant`;
      return response;
    };
    const ready = (async () => {
      const initialized = await rpc("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "armada", version: VERSION },
      });
      if (initialized.protocolVersion !== 1) throw new HarnessError("invalid_harness_protocol");
      if (this.options.authMethodId) await rpc("authenticate", { methodId: this.options.authMethodId });
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
      let session: ObjectValue;
      if (c.sessionId) {
        if (!object(initialized.agentCapabilities) || initialized.agentCapabilities.loadSession !== true)
          throw new HarnessError("invalid_harness_protocol");
        sessionId = c.sessionId;
        session = await rpc("session/load", { sessionId, cwd, mcpServers });
      } else {
        session = await rpc("session/new", { cwd, mcpServers });
        if (typeof session.sessionId !== "string" || !session.sessionId || session.sessionId.length > 256)
          throw new HarnessError("invalid_harness_protocol");
        sessionId = session.sessionId;
      }
      activeModel = currentModel(session.configOptions, session.models) ?? activeModel;
      const model = c.request.model;
      if (!resumeOnly && model && this.options.modelSelection === "config-option" && model !== "default") {
        if (!availableModel(session.configOptions, model)) throw new RequestRefused("invalid_request");
        const prior = activeModel;
        const updated = await rpc("session/set_config_option", { sessionId, configId: "model", value: model });
        activeModel =
          currentModel(updated.configOptions, updated.models) ??
          (activeModel !== prior ? activeModel : concreteModel(model)) ??
          activeModel;
      }
      c.session(sessionId);
      if (!resumeOnly && model && !this.options.modelSelection) {
        const prior = activeModel;
        const updated = await rpc("session/set_model", { sessionId, modelId: model });
        activeModel =
          currentModel(updated.configOptions, updated.models) ??
          (activeModel !== prior ? activeModel : concreteModel(model)) ??
          activeModel;
      }
      if (!resumeOnly) await this.options.observation?.ready(sessionId);
      replay = false;
    })();
    const done = (async (): Promise<"finished" | "interrupted"> => {
      try {
        await ready;
        if (resumeOnly) return "finished";
        current = begin(c.request.text);
        for (;;) {
          const active: Promise<ObjectValue> = current;
          const response = await (this.options.observation
            ? Promise.race([active, this.options.observation.failed])
            : active);
          // A restart replaces the running native turn but remains the same Armada prompt.
          if (current !== active) continue;
          usage(response);
          const stop = acpStopReasonCode(response.stopReason);
          if (stop === "interrupted") return "interrupted";
          if (stop !== "finished") throw new HarnessError(stop);
          // ACP only streams text chunks. Publish the terminal snapshot with the same identity so
          // journal consumers need not reconstruct a completed answer from partial deltas.
          if (!interrupted && assistantChunks.length)
            c.emit({
              kind: "message",
              text: assistantChunks.join(""),
              partial: false,
              textMode: "snapshot",
              messageId: assistantMessageId,
              ...(activeModel ? { model: activeModel } : {}),
              responseKind: "assistant",
              tools: [],
            });
          return interrupted ? "interrupted" : "finished";
        }
      } catch (error) {
        for (const key of Object.keys(totals)) totals[key] = null;
        if (c.signal.aborted || interrupted) return "interrupted";
        throw error;
      } finally {
        if (usageSeen)
          c.emit({
            kind: "other",
            type: "armada/turnUsage",
            data: { model: activeModel ?? concreteModel(c.request.model) ?? null, ...totals },
          });
        stopped = true;
        failure();
        c.signal.removeEventListener("abort", abort);
        try {
          await this.options.observation?.close();
        } finally {
          await this.children.release(child);
        }
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
        // Definite pre-side-effect refusal: no continuation was installed or cancelled.
        if (!current || stopped || steering) throw new RequestRefused("no_running_turn");
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
    try {
      await this.options.observation?.close();
    } finally {
      await this.children.close();
    }
  }
}

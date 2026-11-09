import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk/core";
import { query } from "@anthropic-ai/claude-agent-sdk/core";
import { ChildOwner } from "./children.ts";
import { validateHarnessCwd } from "./cwd.ts";
import { bounded } from "./deadline.ts";
import { HarnessError, type HarnessErrorCode } from "./errors.ts";
import { PrivateMcpFile } from "./mcp-file.ts";
import type { Driver, DriverContext, Turn } from "./protocol.ts";
/** Each query owns its process and input stream; no global interrupt. */
export class ClaudeDriver implements Driver {
  private children = new ChildOwner();
  private configs = new Set<PrivateMcpFile>();
  private queries = new Set<ReturnType<typeof query>>();
  constructor(private options: { cwd: string; executable: string; env: Record<string, string> }) {}
  start(c: DriverContext): Turn {
    const cwd = validateHarnessCwd(c.request.cwd ?? this.options.cwd);
    if (c.request.fast && (c.request.model ?? "claude-opus-5-5") !== "claude-opus-5-5")
      throw Error("unsupported_fast_model");
    const effort = c.request.reasoningEffort ?? "medium";
    if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw Error("invalid_effort");
    let wake: (() => void) | undefined;
    let closed = false;
    let interrupted = false;
    let latest = crypto.randomUUID();
    let steered = false;
    let terminalError: HarnessErrorCode | undefined;
    // Subagent streams can interleave with the top-level stream.
    const messages = new Map<string | null, string>();
    const completedText = new Map<string, string>();
    const completedFrames = new Set<string>();
    const inputs: SDKUserMessage[] = [];
    const push = (text: string) => {
      latest = crypto.randomUUID();
      inputs.push({
        type: "user",
        uuid: latest,
        priority: "now",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      });
      wake?.();
    };
    push(c.request.text);
    const stream = async function* () {
      while (!closed) {
        const item = inputs.shift();
        if (item) yield item;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    let child: ReturnType<ChildOwner["spawn"]> | undefined;
    const config = c.mcp ? new PrivateMcpFile(this.options.env, c.mcp.servers) : undefined;
    if (config) this.configs.add(config);
    let stderrText = "",
      stderrBytes = 0,
      stderrOverflow = false;
    const options: Options = {
      cwd,
      pathToClaudeCodeExecutable: this.options.executable,
      spawnClaudeCodeProcess: (options) => {
        child = this.children.spawn(options.command, options.args, {
          cwd,
          env: this.options.env,
          signal: options.signal,
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (text: string) => {
          if (stderrOverflow) return;
          stderrBytes += Buffer.byteLength(text);
          if (stderrBytes > 65536) {
            stderrOverflow = true;
            stderrText = "";
          } else stderrText += text;
        });
        return child;
      },
      env: this.options.env,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      strictMcpConfig: true,
      settingSources: [],
      persistSession: true,
      ...(c.request.fast ? { settings: { fastMode: true } } : {}),
      model: c.request.model ?? "claude-opus-5-5",
      effort: effort as NonNullable<Options["effort"]>,
      ...(c.sessionId ? { resume: c.sessionId } : {}),
      ...(config ? { extraArgs: { "mcp-config": config.path } } : {}),
    };
    let q: ReturnType<typeof query>;
    try {
      q = query({ prompt: stream(), options });
    } catch (error) {
      if (config) {
        try {
          config.close();
        } finally {
          this.configs.delete(config);
        }
      }
      throw error;
    }
    this.queries.add(q);
    const interrupt = async () => {
      interrupted = true;
      try {
        await bounded(q.interrupt(), 5000);
      } finally {
        q.close();
      }
    };
    const abort = () => {
      void interrupt().catch(() => {});
    };
    c.signal.addEventListener("abort", abort, { once: true });
    const done = (async () => {
      try {
        for await (const event of q) {
          if ("session_id" in event) c.session(event.session_id);
          if (event.type === "stream_event") {
            const e = event.event;
            const parent = event.parent_tool_use_id ?? null;
            if (e.type === "message_start") messages.set(parent, e.message.id);
            const messageId = messages.get(parent);
            if (e.type === "message_stop") messages.delete(parent);
            if (e.type === "content_block_start" && e.content_block.type === "tool_use")
              c.emit({
                kind: "message",
                text: "",
                partial: true,
                tools: [{ id: e.content_block.id, name: e.content_block.name, input: e.content_block.input }],
              });
            if (e.type === "content_block_delta" && e.delta.type === "text_delta")
              c.emit({
                kind: "message",
                text: e.delta.text,
                partial: true,
                tools: [],
                ...(messageId ? { messageId, textMode: "delta" as const } : {}),
              });
          } else if (event.type === "assistant") {
            if (event.error)
              terminalError =
                event.error === "authentication_failed" || event.error === "cloud_credential_error"
                  ? "authentication_failed"
                  : event.error === "rate_limit"
                    ? "rate_limited"
                    : "harness_failed";
            const tools = event.message.content.flatMap((block) =>
              block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input }] : [],
            );
            // The pinned CLI emits one assistant frame per completed content block,
            // not a full message snapshot. Tool/thinking blocks must not erase text.
            const key = JSON.stringify([event.parent_tool_use_id, event.message.id]);
            if (!completedFrames.has(event.uuid)) {
              completedFrames.add(event.uuid);
              completedText.set(
                key,
                (completedText.get(key) ?? "") +
                  event.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
              );
            }
            c.emit({
              kind: "message",
              messageId: event.message.id,
              textMode: "snapshot",
              text: completedText.get(key) ?? "",
              partial: false,
              model: event.message.model,
              tools,
            });
          } else if (event.type === "user") {
            const content = event.message.content;
            if (Array.isArray(content))
              for (const block of content)
                if (block.type === "tool_result")
                  c.emit({
                    kind: "message",
                    text: "",
                    partial: false,
                    tools: [
                      {
                        id: block.tool_use_id,
                        name: "tool_result",
                        result: { output: block.content, isError: block.is_error ?? false },
                      },
                    ],
                  });
          } else if (event.type === "result") {
            c.emit({ kind: "other", type: "result", data: event });
            const consumed = event.user_message_uuids ?? (event.user_message_uuid ? [event.user_message_uuid] : []);
            if (!interrupted && steered && !consumed.length) throw new HarnessError("invalid_harness_protocol");
            if (!interrupted && consumed.length && !consumed.includes(latest)) continue;
            if (terminalError) throw new HarnessError(terminalError);
            if (interrupted) return "interrupted" as const;
            if (event.subtype !== "success" || event.is_error) throw new HarnessError("harness_failed");
            return "finished" as const;
          } else c.emit({ kind: "other", type: event.type, data: event });
        }
        if (interrupted) return "interrupted" as const;
        throw Error("claude_stream_closed_without_result");
      } finally {
        closed = true;
        wake?.();
        try {
          q.close();
          this.queries.delete(q);
          if (child) await this.children.release(child);
        } finally {
          if (config) {
            try {
              config.close();
            } finally {
              this.configs.delete(config);
            }
          }
          c.signal.removeEventListener("abort", abort);
          if (stderrOverflow || stderrText)
            c.emit({
              kind: "other",
              type: "harness_stderr",
              data: stderrOverflow ? { truncated: true } : { text: stderrText },
            });
        }
      }
    })();
    return {
      done,
      interrupt,
      steer: async (text) => {
        if (closed) throw Error("no_running_turn");
        steered = true;
        push(text);
      },
    };
  }
  async close() {
    for (const q of this.queries) q.close();
    try {
      await this.children.close();
    } finally {
      for (const config of this.configs) {
        config.close();
        this.configs.delete(config);
      }
    }
  }
}

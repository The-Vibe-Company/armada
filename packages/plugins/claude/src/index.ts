import type { NodeProvider, PluginContext, RuntimeProvider, WorkerRef } from "@armada/plugin-api";

interface ClaudeOptions {
  command?: string;
  args?: string[];
}
const same = (a: WorkerRef, b: WorkerRef) =>
  a.project === b.project &&
  a.ticket === b.ticket &&
  a.session === b.session &&
  a.generation === b.generation &&
  a.handle === b.handle;

/** A bound instance belongs to one node. No registry, store or credentials reach this plugin. */
export function claudeRuntime(options: ClaudeOptions = {}, node?: NodeProvider): RuntimeProvider {
  const workers = new Map<
    string,
    {
      ref: WorkerRef;
      stream: boolean;
      activity: "working" | "idle";
      seen: string;
      pending: string;
      turns: number;
      deliveries: Map<string, string>;
      reply?: string;
      failure?: string;
    }
  >();
  const facilities = () => {
    if (!node) throw new Error("Claude runtime needs host node binding");
    return node;
  };
  const record = (ref: WorkerRef) => {
    const value = workers.get(ref.handle);
    if (!value || !same(value.ref, ref)) throw new Error("Worker generation changed; runtime untouched");
    return value;
  };
  const consume = (value: ReturnType<typeof record>, output: string) => {
    let delta = output.startsWith(value.seen) ? output.slice(value.seen.length) : output;
    if (!output.startsWith(value.seen) && value.seen) {
      // Node facilities retain a bounded tail. Resume after an overlapping suffix when it rolls over.
      const suffix = value.seen.slice(-4096);
      const overlap = output.indexOf(suffix);
      if (overlap >= 0) delta = output.slice(overlap + suffix.length);
      else value.pending = "";
    }
    value.seen = output;
    const lines = (value.pending + delta).split(/\r?\n/);
    value.pending = lines.pop() ?? "";
    let reply: string | undefined;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === "result") {
          value.turns = Math.max(0, value.turns - 1);
          value.activity = value.turns ? "working" : "idle";
          if (event.is_error === true) {
            value.failure =
              typeof event.result === "string" && event.result
                ? event.result
                : Array.isArray(event.errors)
                  ? event.errors.filter((error: unknown) => typeof error === "string").join("\n")
                  : "Claude CLI turn failed";
          } else if (typeof event.result === "string") reply = event.result;
        } else if (["assistant", "stream_event", "user"].includes(event.type)) value.activity = "working";
      } catch {
        /* A terminal diagnostic is not state evidence. */
      }
    }
    if (reply !== undefined) value.reply = reply;
    return value.reply;
  };
  return {
    withNode: (selected) => claudeRuntime(options, selected),
    prepare: (request) => facilities().prepare(request),
    async launch(request) {
      // The conformance host supplies an explicit command. Production uses the CLI's streaming protocol.
      const stream = !request.command;
      const ref = await facilities().launch({
        ...request,
        command: request.command || options.command || "claude",
        args: stream
          ? [
              ...(options.args ?? []),
              "--print",
              "--verbose",
              "--input-format",
              "stream-json",
              "--output-format",
              "stream-json",
              ...request.args,
            ]
          : request.args,
      });
      workers.set(ref.handle, {
        ref: { ...ref },
        stream,
        activity: "idle",
        seen: "",
        pending: "",
        turns: 0,
        deliveries: new Map(),
      });
      return ref;
    },
    async deliver(ref, message, key) {
      const value = record(ref);
      const prior = value.deliveries.get(key);
      if (prior !== undefined) {
        if (prior !== message) throw new Error("Delivery key already used with another message");
        return;
      }
      const input = value.stream
        ? JSON.stringify({ type: "user", message: { role: "user", content: message } })
        : message;
      // The selected node checks ownership again at the actual native write.
      const before = await facilities().observe(ref);
      consume(value, before.reply ?? "");
      await facilities().deliver(ref, input, key);
      value.deliveries.set(key, message);
      value.reply = undefined;
      value.failure = undefined;
      value.turns++;
      value.activity = "working";
    },
    async observe(ref) {
      const value = record(ref);
      const observed = await facilities().observe(ref);
      if (!value.stream || observed.state !== "running") return observed;
      const reply = consume(value, observed.reply ?? "");
      const answer = value.failure || reply;
      return {
        state: value.failure ? "failed" : observed.state,
        activity: value.activity,
        ...(answer === undefined ? {} : { reply: answer }),
      };
    },
    async stop(ref) {
      record(ref);
      await facilities().stop(ref);
    },
  };
}

export function activate(ctx: PluginContext): void {
  const options = (ctx.config.runtime?.claude ?? {}) as ClaudeOptions;
  ctx.register.runtime("claude", claudeRuntime(options));
}

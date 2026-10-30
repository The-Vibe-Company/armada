import type { NodeProvider, PluginContext, RuntimeProvider, WorkerRef } from "@armada/plugin-api";
import { DRIVER } from "./driver.ts";
import { codexConnection } from "./status.ts";

interface Options {
  command?: string;
  binary?: string;
  model?: string;
  effort?: string;
  extraArgs?: string[];
}
const same = (a: WorkerRef, b: WorkerRef) =>
  a.project === b.project &&
  a.ticket === b.ticket &&
  a.session === b.session &&
  a.generation === b.generation &&
  a.handle === b.handle;

/** A bound runtime uses only the host's selected node, including for the sign-in probe. */
export function codexRuntime(options: Options = {}, node?: NodeProvider): RuntimeProvider {
  const workers = new Map<
    string,
    {
      ref: WorkerRef;
      native: boolean;
      sequence: number;
      sent: number;
      completed: number;
      deliveries: Map<string, string>;
      reply?: string;
      failure?: string;
      refusal?: string;
      stopped?: boolean;
    }
  >();
  const facilities = () => {
    if (!node) throw new Error("codex runtime needs host node binding");
    return node;
  };
  const record = (ref: WorkerRef) => {
    const value = workers.get(ref.handle);
    if (!value || !same(value.ref, ref)) throw new Error("Worker generation changed; runtime untouched");
    return value;
  };
  const consume = (value: ReturnType<typeof record>, output: string) => {
    // The node retains a bounded tail. Sequence numbers make repeated/rolled observations harmless.
    for (const line of output.split(/\r?\n/).slice(0, -1)) {
      try {
        const event = JSON.parse(line);
        if (event.armada !== 1 || !Number.isInteger(event.seq) || event.seq <= value.sequence) continue;
        value.sequence = event.seq;
        if (event.kind === "reply" && typeof event.text === "string") value.reply = event.text;
        if (event.kind === "failure") value.failure = "codex CLI turn failed";
        if (event.kind === "done" && Number.isSafeInteger(event.completed) && event.completed >= 0)
          value.completed = Math.max(value.completed, event.completed);
      } catch {
        /* A truncated line or terminal diagnostic is not state evidence. */
      }
    }
  };
  return {
    ...codexConnection(options.binary ?? options.command ?? "codex"),
    withNode: (selected) => codexRuntime(options, selected),
    prepare: (request) => facilities().prepare(request),
    async launch(request) {
      const native = !request.command;
      // The daemon supplies routing in generic model/effort flags. Copy V1's CLI conventions
      // (packages/cli/src/herdr.ts harnessArgs), never import its adapters.
      let model = options.model;
      let effort = options.effort;
      const extraArgs = [...(options.extraArgs ?? [])];
      for (let i = 0; i < request.args.length; i++) {
        const arg = request.args[i];
        if (arg === undefined) continue;
        if (arg === "--model" || arg === "--effort") {
          const next = request.args[++i];
          if (!next) throw new Error(`${arg} requires a value`);
          if (arg === "--model") model = next;
          else effort = next;
        } else extraArgs.push(arg);
      }
      const ref = await facilities().launch(
        native
          ? {
              ...request,
              command: "node",
              args: [
                "--input-type=module",
                "-e",
                DRIVER,
                JSON.stringify({ command: options.binary ?? options.command ?? "codex", model, effort, extraArgs }),
              ],
            }
          : request,
      );
      const value: ReturnType<typeof record> = {
        ref: { ...ref },
        native,
        sequence: 0,
        sent: 0,
        completed: 0,
        deliveries: new Map<string, string>(),
      };
      workers.set(ref.handle, value);
      if (native) {
        // The driver probes on the selected node and never forwards credential diagnostics.
        // It cannot start inference until this handshake succeeds and the host delivers a brief.
        try {
          const deadline = Date.now() + 15_000;
          for (;;) {
            const observation = await facilities().observe(ref);
            const events = (observation.reply ?? "").split(/\r?\n/).flatMap((line) => {
              try {
                return [JSON.parse(line)];
              } catch {
                return [];
              }
            });
            if (events.some((event) => event.armada === 1 && event.kind === "ready")) break;
            if (
              observation.state === "failed" ||
              observation.state === "stopped" ||
              events.some((event) => event.armada === 1 && event.kind === "refused") ||
              Date.now() >= deadline
            )
              throw new Error(
                "codex credentials unavailable; the owner runs `codex login` on the selected node and retries",
              );
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        } catch {
          // The host owns cleanup under its exact-handle guard. Launch prerequisites may
          // already have changed, so never try to stop under the launch guard here.
          value.refusal =
            "codex credentials unavailable; the owner runs `codex login` on the selected node and retries";
        }
      }
      return ref;
    },
    async deliver(ref, message, key) {
      const value = record(ref);
      if (value.refusal) throw new Error(value.refusal);
      if (!key) throw new Error("Delivery key must not be empty");
      const previous = value.deliveries.get(key);
      if (previous !== undefined) {
        if (previous !== message) throw new Error("Delivery key already used with another message");
        return;
      }
      const before = await facilities().observe(ref);
      if (value.native) consume(value, before.reply ?? "");
      await facilities().deliver(ref, value.native ? JSON.stringify({ key, message }) : message, key);
      // Node delivery is keyed and serialized; concurrent retries must count only one turn.
      if (!value.deliveries.has(key)) {
        value.deliveries.set(key, message);
        value.reply = undefined;
        value.failure = undefined;
        value.sent++;
      }
    },
    async observe(ref) {
      const value = record(ref);
      if (value.stopped) return { state: "stopped", activity: "idle", ...(value.reply ? { reply: value.reply } : {}) };
      if (value.refusal) return { state: "failed", activity: "idle", reply: value.refusal };
      const observation = await facilities().observe(ref);
      if (!value.native) return observation;
      consume(value, observation.reply ?? "");
      return {
        state: value.failure && observation.state === "running" ? ("failed" as const) : observation.state,
        activity:
          observation.state === "running" && value.sent > value.completed ? ("working" as const) : ("idle" as const),
        ...((value.failure ?? value.reply) === undefined ? {} : { reply: value.failure ?? value.reply }),
      };
    },
    async stop(ref) {
      const value = record(ref);
      await facilities().stop(ref);
      value.stopped = true;
    },
  };
}

export function activate(ctx: PluginContext): void {
  ctx.register.runtime("codex", codexRuntime((ctx.config.runtime?.codex ?? {}) as Options));
}

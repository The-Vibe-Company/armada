import { randomUUID } from "node:crypto";
import { type AuthEvent, authEventSchema, type ServerMessage, PROTOCOL_VERSION as version } from "@armada/protocol";
import type { AuthInteraction, AuthEvent as PiAuthEvent } from "@earendil-works/pi-ai";

/** pi interactions plus terminal output, shared with provider connection flows. */
export type FlowInteraction = Omit<AuthInteraction, "notify"> & { notify(event: AuthEvent | PiAuthEvent): void };

type Send = (message: ServerMessage) => void;
interface Flow {
  owner: object;
  id: string;
  controller: AbortController;
  scope?: string;
  done: Promise<void>;
  prompt?: { id: string; resolve(value: string): void; reject(): void };
}

/** Shared, connection-owned auth interaction. No browser, logger, event store or secrets in errors. */
export class AuthFlows {
  #active?: Flow;

  start(
    owner: object,
    id: string,
    send: Send,
    run: (interaction: FlowInteraction) => Promise<void>,
    scope?: string,
  ): void {
    if (this.#active) {
      send({ type: "error", version, id, code: "invalid-message", message: "Another sign-in is in progress" });
      return;
    }
    const flow: Flow = { owner, id, controller: new AbortController(), scope, done: Promise.resolve() };
    this.#active = flow;
    const signal = flow.controller.signal;
    const interaction: FlowInteraction = {
      signal,
      notify: (event) => {
        if (this.#active === flow && !signal.aborted)
          send({ type: "auth.event", version, flow: id, event: authEventSchema.parse(event) });
      },
      prompt: (prompt) =>
        new Promise<string>((resolve, reject) => {
          signal.throwIfAborted();
          prompt.signal?.throwIfAborted();
          if (flow.prompt) throw new Error("An auth prompt is already pending");
          const promptId = randomUUID();
          const cleanup = () => {
            if (flow.prompt?.id === promptId) flow.prompt = undefined;
            signal.removeEventListener("abort", abort);
            prompt.signal?.removeEventListener("abort", abort);
          };
          const abort = () => {
            cleanup();
            reject(new Error("Sign-in cancelled"));
          };
          flow.prompt = {
            id: promptId,
            resolve: (value) => {
              cleanup();
              resolve(value);
            },
            reject: abort,
          };
          signal.addEventListener("abort", abort, { once: true });
          prompt.signal?.addEventListener("abort", abort, { once: true });
          send({
            type: "auth.prompt",
            version,
            flow: id,
            id: promptId,
            promptType: prompt.type,
            message: prompt.message,
            ...("placeholder" in prompt ? { placeholder: prompt.placeholder } : {}),
            ...("options" in prompt ? { options: [...prompt.options] } : {}),
          });
        }),
    };
    flow.done = Promise.resolve()
      .then(() => run(interaction))
      .catch(() => {
        send({
          type: "error",
          version,
          id,
          code: "internal",
          message: signal.aborted ? "Sign-in cancelled" : "Sign-in failed. Try again.",
        });
      })
      .finally(() => {
        flow.prompt?.reject();
        if (this.#active === flow) this.#active = undefined;
      });
  }

  answer(owner: object, flow: string, id: string, value: string): boolean {
    const active = this.#active;
    if (!active || active.owner !== owner || active.id !== flow || active.prompt?.id !== id) return false;
    active.prompt.resolve(value);
    return true;
  }

  async cancel(owner: object, flow?: string): Promise<boolean> {
    const active = this.#active;
    if (!active || active.owner !== owner || (flow !== undefined && active.id !== flow)) return false;
    active.controller.abort();
    await active.done;
    return true;
  }

  async cancelScope(scope: string): Promise<void> {
    const active = this.#active;
    if (active?.scope !== scope) return;
    active.controller.abort();
    await active.done;
  }

  async close(): Promise<void> {
    const active = this.#active;
    active?.controller.abort();
    await active?.done;
  }
}

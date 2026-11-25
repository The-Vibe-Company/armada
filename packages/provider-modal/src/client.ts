import { AsyncLocalStorage } from "node:async_hooks";
import type { ModalBinding } from "@armada/core";
import { ModalClient } from "modal";
import { refusal } from "./errors.ts";
export interface ModalConnection {
  client?: ModalClient;
  tokenId?: string;
  tokenSecret?: string;
}
const stopBudget = new AsyncLocalStorage<{ signal: AbortSignal; deadlineAt: number | undefined }>();
export function withModalStopSignal<T>(
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
  work: () => Promise<T>,
) {
  return signal ? stopBudget.run({ signal, deadlineAt }, work) : work();
}

export function modalStopTimeout(maximum: number) {
  const budget = stopBudget.getStore();
  budget?.signal.throwIfAborted();
  const remaining = budget?.deadlineAt === undefined ? maximum : budget.deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("Modal stop dispatch deadline elapsed.");
  return Math.min(maximum, remaining);
}
export function modalConnection(options: ModalConnection): ModalClient {
  const supplied = options.tokenId !== undefined || options.tokenSecret !== undefined;
  if ((!options.client || supplied) && (!options.tokenId?.trim() || !options.tokenSecret?.trim()))
    throw refusal(
      "provider_routing_unavailable",
      "A complete explicit Modal token pair or an explicitly provided public ModalClient is required.",
    );
  if (options.client) return options.client;
  const { tokenId, tokenSecret } = options;
  if (!tokenId || !tokenSecret) throw refusal("provider_routing_unavailable", "Explicit Modal credentials required.");
  return new ModalClient({
    tokenId,
    tokenSecret,
    grpcMiddleware: [
      async function* (call, rpc) {
        const stop = stopBudget.getStore()?.signal;
        if (!stop) return yield* call.next(call.request, rpc);
        stop.throwIfAborted();
        const signal = rpc.signal ? AbortSignal.any([stop, rpc.signal]) : stop;
        const bounded = { ...rpc, signal, retries: 0 };
        return yield* call.next(call.request, bounded);
      },
    ],
  });
}

export async function boundModalApp(client: Pick<ModalClient, "apps">, appName: string, binding: ModalBinding) {
  const app = await client.apps.fromName(appName, { environment: binding.environment, createIfMissing: false });
  if (app.appId !== binding.appId) throw refusal("forbidden", "Modal App does not match the immutable binding.");
  return app;
}

export function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined) {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

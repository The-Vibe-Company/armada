import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderDispatchGuard } from "@armada/core";
import { ModalClient } from "modal";
import { refusal } from "./errors.ts";

const dispatch = new AsyncLocalStorage<{ guard: ProviderDispatchGuard; reachedTransport: boolean }>();

export function withModalDispatch<T>(guard: ProviderDispatchGuard | undefined, work: () => Promise<T>): Promise<T> {
  return guard ? dispatch.run({ guard, reachedTransport: false }, work) : work();
}

type ModalMiddleware = NonNullable<NonNullable<ConstructorParameters<typeof ModalClient>[0]>["grpcMiddleware"]>[number];

/** This mutation did not reach the SDK transport. */
export class ModalRpcDispatchRefused extends Error {
  constructor(cause: unknown) {
    super("Modal mutation dispatch authority expired or changed.", { cause });
  }
}

const guardedMutation = /\/(SandboxCreate(?:V2)?|SandboxTerminate(?:V2)?|ImageDelete|TaskExecStdinWrite)$/;

function dispatchSignal(guard: ProviderDispatchGuard, signal?: AbortSignal) {
  return guard.signal && signal ? AbortSignal.any([guard.signal, signal]) : (guard.signal ?? signal);
}

export const fenceModalMutation: ModalMiddleware = async function* (call, options) {
  const context = dispatch.getStore();
  if (!context || !guardedMutation.test(call.method.path)) return yield* call.next(call.request, options);
  const { guard } = context;
  // The outer middleware passes cancellation through auth and disables retries.
  const signal = dispatchSignal(guard, options.signal);
  const fenced = { ...options, retries: 0, ...(signal ? { signal } : {}) };
  try {
    return yield* call.next(call.request, fenced);
  } catch (error) {
    // Authentication can abort before invoking the innermost middleware.
    if (!context.reachedTransport) throw new ModalRpcDispatchRefused(error);
    throw error;
  }
};

export const checkModalDispatch: ModalMiddleware = async function* (call, options) {
  const context = dispatch.getStore();
  if (context && guardedMutation.test(call.method.path)) {
    const { guard } = context;
    try {
      // Run after the SDK's awaited auth refresh, immediately before transport.
      await guard();
      guard.signal?.throwIfAborted();
      options.signal?.throwIfAborted();
    } catch (error) {
      if (context.reachedTransport && !call.method.path.endsWith("/TaskExecStdinWrite")) throw error;
      throw new ModalRpcDispatchRefused(error);
    }
    context.reachedTransport = true;
    const signal = dispatchSignal(guard, options.signal);
    return yield* call.next(call.request, signal ? { ...options, signal } : options);
  }
  return yield* call.next(call.request, options);
};

export interface ModalConnection {
  /** Explicit server-owned public SDK client; may use an operator-managed profile. */
  client?: ModalClient;
  tokenId?: string;
  tokenSecret?: string;
}
/** Never trigger SDK credential/profile fallback accidentally. An implicit-profile client is allowed
 * only when the operator explicitly constructed/injected it; AppID verification still happens. */
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
    grpcMiddleware: [fenceModalMutation],
    grpcDispatchMiddleware: [checkModalDispatch],
  });
}

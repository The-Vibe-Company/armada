import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderDispatchGuard } from "@armada/core";
import { ModalClient } from "modal";
import { refusal } from "./errors.ts";

const dispatch = new AsyncLocalStorage<ProviderDispatchGuard>();

export function withModalDispatch<T>(guard: ProviderDispatchGuard | undefined, work: () => Promise<T>): Promise<T> {
  return guard ? dispatch.run(guard, work) : work();
}

type ModalMiddleware = NonNullable<NonNullable<ConstructorParameters<typeof ModalClient>[0]>["grpcMiddleware"]>[number];

/** This mutation did not reach the SDK transport. */
export class ModalRpcDispatchRefused extends Error {
  constructor(cause: unknown) {
    super("Modal mutation dispatch authority expired or changed.", { cause });
  }
}

export const fenceModalMutation: ModalMiddleware = async function* (call, options) {
  const guard = dispatch.getStore();
  if (!guard || !/\/(SandboxCreate(?:V2)?|SandboxTerminate(?:V2)?|ImageDelete)$/.test(call.method.path))
    return yield* call.next(call.request, options);
  // The public SDK can await preparation before reaching this RPC. Its custom
  // middleware wraps auth and retries, so disable retries for this mutation
  // and pass the attempt signal through the remaining middleware.
  try {
    await guard();
    guard.signal?.throwIfAborted();
  } catch (error) {
    throw new ModalRpcDispatchRefused(error);
  }
  const signal = guard.signal && options.signal ? AbortSignal.any([guard.signal, options.signal]) : guard.signal;
  const fenced = { ...options, retries: 0, ...(signal ? { signal } : {}) };
  return yield* call.next(call.request, fenced);
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
  return new ModalClient({ tokenId, tokenSecret, grpcMiddleware: [fenceModalMutation] });
}

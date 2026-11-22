import type { ModalBinding } from "@armada/core";
import { ModalClient } from "modal";
import { refusal } from "./errors.ts";
export interface ModalConnection {
  client?: ModalClient;
  tokenId?: string;
  tokenSecret?: string;
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
  return new ModalClient({ tokenId, tokenSecret });
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

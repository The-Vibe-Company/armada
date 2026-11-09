import { ModalClient } from "modal";
import { refusal } from "./errors.ts";
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
      "provider_not_configured",
      "A complete explicit Modal token pair or an explicitly provided public ModalClient is required.",
    );
  if (options.client) return options.client;
  const { tokenId, tokenSecret } = options;
  if (!tokenId || !tokenSecret) throw refusal("provider_not_configured", "Explicit Modal credentials required.");
  return new ModalClient({ tokenId, tokenSecret });
}

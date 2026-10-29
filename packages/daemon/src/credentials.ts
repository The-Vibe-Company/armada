import { type ClientMessage, PROTOCOL_VERSION, type ServerMessage } from "@armada/protocol";
import type { Keychain } from "./keychain.ts";

export type CredentialRequest = Extract<ClientMessage, { type: "credentials.set" | "credentials.status" }>;

/** Called only after protocol admission. No event writer or logger has access to the request. */
export async function dispatchCredentials(request: CredentialRequest, keychain: Keychain): Promise<ServerMessage> {
  const base = { version: PROTOCOL_VERSION, id: request.id };
  try {
    if (request.type === "credentials.set") await keychain.setCoordinator(request.provider, request.key);
    return { ...base, type: "credentials.result", ...(await keychain.status()) };
  } catch {
    return {
      ...base,
      type: "error",
      code: "internal",
      message: "Could not access credential storage. Unlock it and try again.",
    };
  }
}

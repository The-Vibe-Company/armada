import { MODEL_ACCOUNT_WRITE_TIMEOUT_MS } from "@armada/core";
import type { AuthIo } from "./auth-commands.ts";
import { createSdkCommandClient } from "./sdk-session.ts";

export async function control<T>(
  auth: AuthIo,
  route: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const client = await createSdkCommandClient(auth);
  const deadline =
    signal ??
    (route === "creds/accounts/set" || route === "creds/set"
      ? AbortSignal.timeout(MODEL_ACCOUNT_WRITE_TIMEOUT_MS)
      : undefined);
  return client.control<T>(route, body, deadline);
}

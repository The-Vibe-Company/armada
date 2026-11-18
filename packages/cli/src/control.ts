import { MODEL_ACCOUNT_WRITE_TIMEOUT_MS } from "@armada/core";
import { createArmadaApiClient } from "./armada-api.ts";
import type { AuthIo } from "./auth-commands.ts";

/**
 * One call to the Armada server's control API, as the signed-in user. The server address is
 * `ARMADA_URL`; the bearer is an Armada session or ARMADA_TOKEN. The CLI holds no provider keys.
 */
export async function control<T>(
  auth: AuthIo,
  route: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const client = await createArmadaApiClient(auth);
  const deadline =
    signal ??
    (route === "creds/accounts/set" || route === "creds/set"
      ? AbortSignal.timeout(MODEL_ACCOUNT_WRITE_TIMEOUT_MS)
      : undefined);
  return client.control<T>(route, body, deadline);
}

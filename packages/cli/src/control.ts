import { VaultError } from "@armada/core";
import type { AuthIo } from "./auth-commands.ts";
import { createArmadaApiClient } from "./armada-api.ts";

/**
 * One call to the Armada server's control API, as the signed-in user. The server address is
 * `ARMADA_URL`; the bearer is an Armada session or ARMADA_TOKEN. The CLI holds no provider keys.
 */
export async function control<T>(auth: AuthIo, route: string, body: Record<string, unknown>): Promise<T> {
  const client = await createArmadaApiClient(auth);
  try {
    return await client.request<T>(`/api/v1/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw error;
  }
}

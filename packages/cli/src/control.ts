import { AuthError } from "@armada/auth";
import { VaultError, type VaultErrorCode } from "@armada/core";
import { type AuthIo, signedIn } from "./auth-commands.ts";

const CODES: readonly VaultErrorCode[] = [
  "invalid",
  "forbidden",
  "not_found",
  "conflict",
  "missing_credential",
  "unavailable",
];

/**
 * One call to the Armada server's control API, as the signed-in user. The server address is
 * `ARMADA_URL`; the bearer is the Supabase access token from `armada login`. The CLI holds no
 * service role key and no encryption key: the server checks who you are and does what needs them.
 */
export async function control<T>(auth: AuthIo, route: string, body: Record<string, unknown>): Promise<T> {
  const { session } = await signedIn(auth);
  const base = session.armadaUrl ?? auth.env.ARMADA_URL;
  if (!base) throw new AuthError("Run armada login --url <url> to select the Armada server.", "usage");
  let response: Response;
  try {
    response = await auth.fetch(new URL(`/api/v1/${route}`, base), {
      method: "POST",
      headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError("Armada could not reach the server.", "unavailable");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) return payload as T;
  if (response.status === 401) throw new AuthError("Run armada login.", "unauthorized");
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
  const code = CODES.find((candidate) => candidate === error.code) ?? "unavailable";
  const message = typeof error.message === "string" ? error.message : `The server answered ${response.status}.`;
  throw new VaultError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

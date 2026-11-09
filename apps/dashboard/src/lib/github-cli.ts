/**
 * The Armada CLI's GitHub sign-in reuses the dashboard's registered `/github/callback`. The API creates a
 * high-entropy, one-use flow state prefixed `armada_cli_` and binds it to the CLI user in its database; GitHub
 * returns here, and the dashboard relays `{state, code}` server-side to the API's public
 * `POST /api/v1/github/oauth/callback`. No browser cookie, session or Armada bearer is involved: the state names
 * the actor. Every other state keeps the web flow and its state cookie, unchanged.
 */

export const CLI_STATE_PREFIX = "armada_cli_";
export const CLI_CALLBACK_PATH = "/api/v1/github/oauth/callback";
/** The public page that tells the person to go back to their terminal. */
export const CLI_DONE_PATH = "/github/cli";

const CLI_STATE = /^armada_cli_[A-Za-z0-9_-]{32,256}$/;
const CODE = /^[A-Za-z0-9_-]{1,512}$/;
const RELAY_TIMEOUT_MS = 15_000;

export type CliOutcome = "connected" | "denied" | "failed";

export type CliCallback = { kind: "relay"; state: string; code: string } | { kind: "done"; outcome: CliOutcome };

/**
 * Null when the callback belongs to the web flow (no state carries the CLI prefix). Otherwise the checked input,
 * or a fixed outcome: a provider error, a repeated parameter or a malformed state or code ends the flow here,
 * before anything is sent and without copying any of it anywhere.
 */
export function cliGitHubCallback(params: URLSearchParams): CliCallback | null {
  const states = params.getAll("state");
  if (!states.some((value) => value.startsWith(CLI_STATE_PREFIX))) return null;
  if (params.has("error")) {
    return { kind: "done", outcome: params.get("error") === "access_denied" ? "denied" : "failed" };
  }
  const codes = params.getAll("code");
  const [state] = states;
  const [code] = codes;
  if (states.length !== 1 || codes.length !== 1 || !state || !code) return { kind: "done", outcome: "failed" };
  if (!CLI_STATE.test(state) || !CODE.test(code)) return { kind: "done", outcome: "failed" };
  return { kind: "relay", state, code };
}

/**
 * Sends `{state, code}` to the Armada API, and nothing else: no cookie, no authorization header. The API checks the
 * flow is pending, unexpired, not cancelled and not used, then completes it. Only success or failure comes back to
 * the browser; the API's answer is not shown.
 */
export async function relayCliGitHubCallback(
  serverUrl: string | null,
  input: { state: string; code: string },
  doFetch: typeof fetch = fetch,
): Promise<CliOutcome> {
  if (!serverUrl) return "failed";
  let origin: string;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return "failed";
  }
  try {
    const response = await doFetch(new URL(CLI_CALLBACK_PATH, origin), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ state: input.state, code: input.code }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok ? "connected" : "failed";
  } catch {
    return "failed";
  }
}

export function cliOutcome(value: string | string[] | undefined): CliOutcome {
  return value === "connected" || value === "denied" ? value : "failed";
}

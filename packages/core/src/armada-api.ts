// The Armada API, as the CLI sees it: signing in from a terminal (a device
// code confirmed in the browser), who is signed in, and signing out. It is the
// one address the CLI knows (`resolveCredentials` picks it). The adapter takes
// an injected `fetch`; no error it raises quotes a token or a key.
import type { Fetch } from "./linear.ts";
import { networkReason } from "./linear.ts";

/** How a terminal proves who it is: the session of `armada login`, or an organization API key. */
export type ArmadaSignIn = { kind: "session"; token: string } | { kind: "api-key"; key: string };

/** Who the terminal is signed in as, from `GET /api/cli/session`. Carries no secret. */
export interface ArmadaIdentity {
  schemaVersion: 1;
  via: "session" | "api-key";
  /** The person, for a session; null for an API key, which acts for its organization. */
  user: { id: string; name: string; email: string } | null;
  /** The organization the terminal acts for; null when the person belongs to none yet. */
  organization: { id: string; name: string; slug: string; role: string | null } | null;
  apiKey: { id: string; name: string | null; start: string | null } | null;
  expiresAt: string | null;
}

export interface DeviceCode {
  deviceCode: string;
  /** What the person types or checks in the browser, e.g. WDJB-MJHT. */
  userCode: string;
  verificationUri: string;
  /** The same page with the code filled in. */
  verificationUriComplete: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

/** A code as the person reads it: WDJB-MJHT. */
export const displayCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

export type DevicePoll =
  | { state: "approved"; token: string }
  | { state: "pending" }
  | { state: "slow-down" }
  | { state: "denied" }
  | { state: "expired" };

/**
 * A refusal or failure of the Armada API. `signedOut` means the credential is
 * missing, expired or revoked; `next` is the step the server or the CLI names.
 */
export class ArmadaApiError extends Error {
  constructor(
    message: string,
    readonly next: string | null = null,
    readonly signedOut = false,
  ) {
    super(message);
  }
}

export const LOGIN_NEXT = "armada login";
const TIMEOUT_MS = 30_000;

/** The API's base URL, checked: an http(s) address with no query. */
export function apiBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ArmadaApiError(
      `the Armada API address "${value}" is not a URL`,
      "ARMADA_API_URL or [api] url in config.toml",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new ArmadaApiError(`the Armada API address must be http or https, not ${url.protocol}`);
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export interface ArmadaApiOptions {
  url: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

export function armadaApi(opts: ArmadaApiOptions) {
  const base = apiBaseUrl(opts.url);
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const host = base.host;

  async function call(
    method: string,
    path: string,
    init: { body?: object; signIn?: ArmadaSignIn } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body) headers["Content-Type"] = "application/json";
    if (init.signIn?.kind === "session") headers.Authorization = `Bearer ${init.signIn.token}`;
    if (init.signIn?.kind === "api-key") headers["x-api-key"] = init.signIn.key;
    const res = await doFetch(new URL(`api/cli/${path}`, base).toString(), {
      method,
      headers,
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err: unknown) => {
      throw new ArmadaApiError(
        `Armada (${host}) unreachable: ${networkReason(err, timeoutMs)}`,
        "the same command again once it answers, or check ARMADA_API_URL",
      );
    });
    const body = (await res.json().catch(() => null)) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new ArmadaApiError(
        `Armada (${host}) answered HTTP ${res.status} without JSON: is ${base.origin} an Armada?`,
        "check ARMADA_API_URL or [api] url in config.toml",
      );
    return { status: res.status, body: body as Record<string, unknown> };
  }

  /** The server's own refusal, with its next step when it gives one. */
  const refusal = (status: number, body: Record<string, unknown>, what: string | null) => {
    const error = typeof body.error === "string" ? body.error : `HTTP ${status}`;
    const next = typeof body.next === "string" ? body.next : status === 401 ? LOGIN_NEXT : null;
    return new ArmadaApiError(what ? `${what}: ${error}` : error, next, status === 401);
  };

  return {
    /** Starts `armada login`: a code for the person to confirm in the browser. */
    async startDeviceLogin(): Promise<DeviceCode> {
      const { status, body } = await call("POST", "device/code");
      if (status !== 200) throw refusal(status, body, "Armada refused to start the sign-in");
      const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
      const num = (k: string, d: number) => (typeof body[k] === "number" && body[k] > 0 ? (body[k] as number) : d);
      if (!str("device_code") || !str("user_code") || !str("verification_uri"))
        throw new ArmadaApiError(`Armada (${host}) answered the sign-in without a code`);
      return {
        deviceCode: str("device_code"),
        userCode: str("user_code"),
        verificationUri: str("verification_uri"),
        verificationUriComplete: str("verification_uri_complete") || str("verification_uri"),
        expiresInSeconds: num("expires_in", 900),
        intervalSeconds: num("interval", 5),
      };
    },

    /** One poll of the device code (RFC 8628): approved with a token, or why not yet. */
    async pollDeviceLogin(deviceCode: string): Promise<DevicePoll> {
      const { status, body } = await call("POST", "device/token", { body: { device_code: deviceCode } });
      if (status === 200 && typeof body.access_token === "string" && body.access_token)
        return { state: "approved", token: body.access_token };
      switch (body.error) {
        case "authorization_pending":
          return { state: "pending" };
        case "slow_down":
          return { state: "slow-down" };
        case "access_denied":
          return { state: "denied" };
        case "expired_token":
        case "invalid_grant":
          return { state: "expired" };
      }
      throw refusal(status, body, "Armada refused the sign-in");
    },

    /** Who `signIn` is; an ArmadaApiError with `signedOut` when it is expired or revoked. */
    async whoami(signIn: ArmadaSignIn): Promise<ArmadaIdentity> {
      const { status, body } = await call("GET", "session", { signIn });
      if (status !== 200) throw refusal(status, body, status === 401 ? null : "Armada could not say who is signed in");
      return body as unknown as ArmadaIdentity;
    },

    /** Revokes the session of `armada login` on the server. */
    async signOut(signIn: ArmadaSignIn): Promise<void> {
      const { status, body } = await call("DELETE", "session", { signIn });
      if (status !== 200) throw refusal(status, body, "Armada refused the sign-out");
    },
  };
}

export type ArmadaApi = ReturnType<typeof armadaApi>;

export interface WaitForApprovalOptions {
  api: Pick<ArmadaApi, "pollDeviceLogin">;
  code: DeviceCode;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

/**
 * Polls until the person approves or denies the code, or it expires. Waits the
 * server's interval between polls and 5 s more at each `slow_down` (RFC 8628);
 * a network failure backs off the same way and is retried until the code expires.
 */
export async function waitForApproval({ api, code, sleep, now }: WaitForApprovalOptions): Promise<string> {
  const deadline = now().getTime() + code.expiresInSeconds * 1000;
  let interval = code.intervalSeconds * 1000;
  for (;;) {
    await sleep(interval);
    if (now().getTime() > deadline) break;
    let poll: DevicePoll;
    try {
      poll = await api.pollDeviceLogin(code.deviceCode);
    } catch (err) {
      if (!(err instanceof ArmadaApiError) || !/unreachable/.test(err.message)) throw err;
      interval = Math.min(interval * 2, 60_000);
      continue;
    }
    if (poll.state === "approved") return poll.token;
    if (poll.state === "denied") throw new ArmadaApiError("the sign-in was denied in the browser", LOGIN_NEXT);
    if (poll.state === "expired") break;
    if (poll.state === "slow-down") interval += 5000;
  }
  throw new ArmadaApiError("the code expired before it was approved", LOGIN_NEXT);
}

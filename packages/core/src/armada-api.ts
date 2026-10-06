// The Armada API, as the CLI sees it: signing in from a terminal (a device
// code confirmed in the browser), who is signed in, signing out, the
// organization's Linear key handed to a signed-in terminal (THE-840), the
// workers' one-time launch tokens and sessions (THE-841), the organization's
// projects, the fleet's live data (THE-850, `fleet-api.ts`), and each
// project's secrets for workers (THE-859). It is the
// one address the CLI knows (`resolveCredentials` picks it). The adapter takes
// an injected `fetch`; no error it raises quotes a token or a key.
import type { Attachment } from "./attachments.ts";
import { HttpRequestError, type HttpRequestOptions, HttpStatusError, httpRequest, retryStatus } from "./http.ts";
import type { Fetch } from "./linear.ts";
import type { RuntimeName } from "./runtime.ts";

/**
 * How a terminal proves who it is: the session of `armada login`, an
 * organization API key, or the worker session of `armada login --launch-token`,
 * which only acts on its own ticket of its own project.
 */
export type ArmadaSignIn =
  | { kind: "session"; token: string }
  | { kind: "api-key"; key: string }
  | { kind: "worker"; token: string; ticket: string; project: string };

/**
 * What a command asks keys for: the project's own Linear key wins for it.
 * Armada refuses a worker session anything but its own ticket's worker commands.
 */
export interface KeysPurpose {
  command?: string;
  project: string;
  ticket?: string;
}

/** How `armada brief` shows a launch token outside `--prompt`: it signs nobody in. */
export const MASKED_LAUNCH_TOKEN = "armada_launch_••••";

/** Whether a launch token is the masked one of `armada brief`'s human view (its dots survive any copy). */
export const isMaskedLaunchToken = (token: string) => token.includes("•");

/** What `armada login` and Armada say to a worker given the masked token, and what it does next. */
export const MASKED_LAUNCH_TOKEN_REFUSAL = {
  error: "this is the masked token from `armada brief`'s human view, not a launch token",
  next: "ask the coordinator for the `armada brief <ticket> --prompt` text: only it carries the token",
} as const;

/** A one-time launch token for one ticket, from `POST /api/cli/launch-tokens`. */
export interface LaunchToken {
  token: string;
  expiresAt: string;
  worker: { id: string; project: string; ticket: string };
  organization: { id: string; name: string; slug: string };
}

/** The worker session a launch token was exchanged for. */
export interface WorkerSession {
  token: string;
  worker: { id: string; project: string; ticket: string; launchedBy: string };
  organization: { id: string; name: string; slug: string };
  expiresAt: string;
}

/** Who the terminal is signed in as, from `GET /api/cli/session`. Carries no secret. */
export interface ArmadaIdentity {
  schemaVersion: 1;
  via: "session" | "api-key" | "worker";
  /** The person, for a session; null for an API key, which acts for its organization. */
  user: { id: string; name: string; email: string } | null;
  /** The organization the terminal acts for; null when the person belongs to none yet. */
  organization: { id: string; name: string; slug: string; role: string | null } | null;
  apiKey: { id: string; name: string | null; start: string | null } | null;
  /** The ticket a worker session acts on, and who launched it; absent from older servers. */
  worker?: { id: string; project: string; ticket: string; launchedBy: string } | null;
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

/**
 * The organization's keys, from `POST /api/cli/credentials`: the Linear key,
 * the person's own when they set one. The fleet's data is never handed out: it
 * is reached through the API (`fleet`).
 */
export interface ArmadaKeysAnswer {
  schemaVersion: 1;
  organization: { id: string; name: string; slug: string };
  linear: { apiKey: string; scope: "project" | "own" | "organization" } | null;
  /** What the organization set but Armada could not hand out. Never a value. */
  warnings: string[];
}

/** The project a secrets request names, as the fleet's requests do. */
export interface SecretsProject {
  slug: string;
  name: string;
  repository: string;
  programRoot: string;
}

/** Where a secret for workers is set: for one project, or for every project of the organization. */
export type SecretScope = "project" | "organization";

/** A secret for workers as `armada secrets` lists it. Never its value. */
export interface ListedSecret {
  name: string;
  scope: SecretScope;
  setBy: string;
  setAt: string;
  /** An organization's secret the project sets too: the project's wins. */
  overridden: boolean;
}

/** One project's secrets for workers, from `POST /api/cli/secrets/release`. */
export interface ReleasedSecrets {
  project: string;
  secrets: { name: string; value: string; scope: SecretScope }[];
  /** Names asked for that are not set. */
  missing: string[];
  /** Why a secret that is set could not be handed out. Never a value. */
  warnings: string[];
}

/** A project of the caller's organization, from `GET /api/cli/projects`. */
export interface ArmadaProject {
  slug: string;
  name: string;
  repository: string;
  programRoot: string;
  /** Whether the project keeps its own Linear key (THE-859): `POST credentials` for it gives that one. */
  ownLinearKey?: boolean;
}

/** A code as the person reads it: WDJB-MJHT. */
export const displayCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

export type DevicePoll =
  | { state: "approved"; token: string }
  | { state: "pending" }
  | { state: "slow-down" }
  | { state: "denied" }
  | { state: "expired" };

/** The CLI's npm package, as the upgrade line names it. */
export const CLI_PACKAGE = "@the-vibe-company/armada";
/** Sent on every call: the version of the CLI that calls. */
export const CLI_VERSION_HEADER = "x-armada-cli-version";
/** On every answer of /api/cli: the oldest CLI that reads it right, and the latest one. */
export const CLI_MINIMUM_HEADER = "x-armada-cli-minimum";
export const CLI_LATEST_HEADER = "x-armada-cli-latest";
/**
 * The oldest CLI that reads every answer of /api/cli right. Raise it with a
 * breaking change to an answer: an older CLI is then told to upgrade instead
 * of failing on a shape it does not know.
 */
export const MINIMUM_CLI_VERSION = "0.2.0";

/** Compares two x.y.z versions by number; a pre-release suffix is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[-+]/)[0]
      ?.split(".")
      .map((n) => Number.parseInt(n, 10) || 0) ?? [];
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The version an outdated CLI is told to install: the latest, never below the minimum. */
export const versionToInstall = (minimum: string, latest: string | null) =>
  latest && compareVersions(latest, minimum) >= 0 ? latest : minimum;

/** The command that installs `version` of the CLI. */
export const installCommand = (version: string) => `npm install -g ${CLI_PACKAGE}@${version}`;

/** The one line an outdated CLI prints. */
export const upgradeLine = (version: string, install: string) =>
  `Armada ${version} is older than this server expects: ${installCommand(install)}`;

/** Where a release's notes are: release-please tags each version v<version>. */
export const releaseNotesUrl = (version: string) =>
  `https://github.com/The-Vibe-Company/armada/releases/tag/v${version}`;

/**
 * The release newer than the running CLI, from the server's latest; null when
 * there is none, or for a development build (0.0.0), which no release replaces.
 */
export const newerRelease = (running: string, latest: string | null | undefined): string | null =>
  latest && running !== "0.0.0" && compareVersions(latest, running) > 0 ? latest : null;

/** A quiet release notice; refresh instructions only when this project's setup differs. */
export const releaseLine = (running: string, latest: string, { setupBehind }: { setupBehind: boolean }) =>
  `Armada ${latest} is out (you run ${running}): armada upgrade${setupBehind ? " — then armada init to refresh this project's skills if still behind" : ""}. Changes: ${releaseNotesUrl(latest)}`;

/** What a server said of the CLIs it serves, from the headers of its last answer. */
export interface ServerCli {
  minimum: string;
  latest: string | null;
}

/**
 * A refusal or failure of the Armada API. `signedOut` means the credential is
 * missing, expired or revoked; `next` is the step the server or the CLI names;
 * `upgrade` is the CLI version to install when this one is older than the
 * server expects (the message is then the upgrade line).
 */
export class ArmadaApiError extends Error {
  constructor(
    message: string,
    readonly next: string | null = null,
    readonly signedOut = false,
    /** The HTTP status of a refusal; null when Armada did not answer. */
    readonly status: number | null = null,
    readonly upgrade: string | null = null,
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
  // Tokens travel in the clear over http: only to this machine.
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new ArmadaApiError(
      `the Armada API address must use https (http only reaches localhost): ${url.origin}`,
      "ARMADA_API_URL or [api] url in config.toml",
    );
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export interface ArmadaApiOptions extends HttpRequestOptions {
  url: string;
  fetch?: Fetch;
  timeoutMs?: number;
  /** This CLI's version: sent on every call, and compared with the oldest the server expects. */
  version?: string;
  /** Called with what every answer says of the CLIs the server serves (`serverCli`). */
  onServerCli?: (server: ServerCli) => void;
}

export function armadaApi(opts: ArmadaApiOptions) {
  const base = apiBaseUrl(opts.url);
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const host = base.host;
  let serverCli: ServerCli | null = null;

  async function call(
    method: string,
    path: string,
    init: { body?: object; signIn?: ArmadaSignIn; timeoutMs?: number; retry?: boolean } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const limit = init.timeoutMs ?? timeoutMs;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body) headers["Content-Type"] = "application/json";
    if (init.signIn?.kind === "session" || init.signIn?.kind === "worker")
      headers.Authorization = `Bearer ${init.signIn.token}`;
    if (init.signIn?.kind === "api-key") headers["x-api-key"] = init.signIn.key;
    if (opts.version) headers[CLI_VERSION_HEADER] = opts.version;
    return httpRequest(
      new URL(`api/cli/${path}`, base).toString(),
      {
        method,
        headers,
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      },
      {
        ...opts,
        timeoutMs: limit,
        retry: init.retry ?? method === "GET",
        retryStatus: (status) => retryStatus(status) && (path !== "credentials" || status !== 429),
        service: "Armada",
      },
      async (res) => {
        // Whatever it answered, an older CLI than the server expects cannot trust its reading of it.
        const minimum = res.headers.get(CLI_MINIMUM_HEADER);
        const latest = res.headers.get(CLI_LATEST_HEADER) || null;
        if (minimum) {
          serverCli = { minimum, latest };
          opts.onServerCli?.(serverCli);
        }
        if (opts.version && minimum && compareVersions(opts.version, minimum) < 0) {
          await res.body?.cancel().catch(() => {});
          const install = versionToInstall(minimum, latest);
          throw new ArmadaApiError(upgradeLine(opts.version, install), null, false, res.status, install);
        }
        // Not modified: no body to read (an unchanged inbox).
        if (res.status === 304) return { status: 304, body: {} };
        const body = (await res.json().catch((err) => {
          if (err instanceof SyntaxError) return null;
          throw err;
        })) as unknown;
        if (typeof body !== "object" || body === null || Array.isArray(body))
          throw new ArmadaApiError(
            `Armada (${host}) answered HTTP ${res.status} without JSON: is ${base.origin} an Armada?`,
            "check ARMADA_API_URL or [api] url in config.toml",
          );
        return { status: res.status, body: body as Record<string, unknown> };
      },
    ).catch((err: unknown) => {
      if (err instanceof HttpStatusError)
        throw new ArmadaApiError(
          `Armada (${host}) ${err.message}`,
          "the same command after the rate limit expires",
          false,
          err.status,
        );
      if (err instanceof HttpRequestError)
        throw new ArmadaApiError(
          `Armada (${host}) unreachable: ${err.message} (${method} ${path})`,
          "the same command again once it answers, or check ARMADA_API_URL",
        );
      throw err;
    });
  }

  /** The server's own refusal, with its next step when it gives one. */
  const refusal = (status: number, body: Record<string, unknown>, what: string | null) => {
    const error = typeof body.error === "string" ? body.error : `HTTP ${status}`;
    const next = typeof body.next === "string" ? body.next : status === 401 ? LOGIN_NEXT : null;
    return new ArmadaApiError(what ? `${what}: ${error}` : error, next, status === 401, status);
  };

  return {
    /** What the server said of the CLIs it serves, from its last answer; null before one, or from an older server. */
    serverCli: () => serverCli,

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

    /** The organization's keys for `signIn`. Answers 503 when that Armada keeps no keys. */
    async credentials(signIn: ArmadaSignIn, purpose: KeysPurpose | null = null): Promise<ArmadaKeysAnswer> {
      const { status, body } = await call("POST", "credentials", {
        signIn,
        body: purpose ? { purpose } : {},
        // This reads a reusable key; each physical attempt remains audited and rate-limited.
        retry: true,
      });
      if (status !== 200) throw refusal(status, body, status === 401 ? null : "Armada gave no keys");
      const str = (v: unknown) => typeof v === "string" && v.length > 0;
      const org = body.organization as ArmadaKeysAnswer["organization"] | undefined;
      const linear = body.linear as ArmadaKeysAnswer["linear"];
      const shaped = body.schemaVersion === 1 && str(org?.id) && (linear === null || str(linear?.apiKey));
      if (!shaped) throw new ArmadaApiError(`Armada (${host}) answered the keys in a shape this CLI does not know`);
      const warnings = Array.isArray(body.warnings)
        ? body.warnings.filter((w): w is string => typeof w === "string")
        : [];
      const scope = linear?.scope === "own" || linear?.scope === "project" ? linear.scope : "organization";
      return {
        schemaVersion: 1,
        organization: org as ArmadaKeysAnswer["organization"],
        linear: linear ? { apiKey: linear.apiKey, scope } : null,
        warnings,
      };
    },

    /** The projects registered for the organization `signIn` acts for. */
    async projects(signIn: ArmadaSignIn): Promise<ArmadaProject[]> {
      const { status, body } = await call("GET", "projects", { signIn });
      if (status !== 200) throw refusal(status, body, status === 401 ? null : "Armada did not list the projects");
      if (!Array.isArray(body.projects))
        throw new ArmadaApiError(`Armada (${host}) answered the projects in a shape this CLI does not know`);
      return (body.projects as Record<string, unknown>[]).flatMap((p) =>
        typeof p.slug === "string" &&
        typeof p.name === "string" &&
        typeof p.repository === "string" &&
        typeof p.programRoot === "string"
          ? [
              {
                slug: p.slug,
                name: p.name,
                repository: p.repository,
                programRoot: p.programRoot,
                ...(p.ownLinearKey === true ? { ownLinearKey: true } : {}),
              },
            ]
          : [],
      );
    },

    /**
     * One operation on the fleet's live data (`fleet-api.ts`): its result,
     * null when Armada answers "not modified" (304), or an ArmadaApiError
     * naming the refusal.
     */
    async fleet(signIn: ArmadaSignIn, op: string, body: object, timeoutMs?: number): Promise<unknown> {
      const { status, body: answer } = await call("POST", `fleet/${op}`, {
        signIn,
        body,
        ...(timeoutMs ? { timeoutMs } : {}),
        retry: [
          "events/latest",
          "events/state",
          "events/since",
          "heartbeats/latest",
          "runtime/handles",
          "runtime/handle",
          "launches",
          "inbox/item",
          "inbox/ticket",
          "validations",
        ].includes(op),
      });
      if (status === 304) return null;
      if (status !== 200) throw refusal(status, answer, status === 401 ? null : "Armada refused");
      if (!("result" in answer))
        throw new ArmadaApiError(`Armada (${host}) answered fleet/${op} in a shape this CLI does not know`);
      return answer.result;
    },

    /** The secrets for workers of `project`: names, where each is set, who set it and when. Never a value. */
    async listSecrets(signIn: ArmadaSignIn, project: SecretsProject): Promise<ListedSecret[]> {
      const { status, body } = await call("POST", "secrets/list", { signIn, body: { project }, retry: true });
      if (status !== 200) throw refusal(status, body, status === 401 ? null : "Armada did not list the secrets");
      if (!Array.isArray(body.secrets))
        throw new ArmadaApiError(`Armada (${host}) answered the secrets in a shape this CLI does not know`);
      return (body.secrets as Record<string, unknown>[]).flatMap((s) =>
        typeof s.name === "string" && typeof s.setBy === "string" && typeof s.setAt === "string"
          ? [
              {
                name: s.name,
                scope: s.scope === "organization" ? ("organization" as const) : ("project" as const),
                setBy: s.setBy,
                setAt: s.setAt,
                overridden: s.overridden === true,
              },
            ]
          : [],
      );
    },

    /** The values of `project`'s secrets for workers, `names` or every one. Armada records the release. */
    async releaseSecrets(
      signIn: ArmadaSignIn,
      project: SecretsProject,
      names: string[] | null = null,
    ): Promise<ReleasedSecrets> {
      const { status, body } = await call("POST", "secrets/release", { signIn, body: { project, names } });
      if (status !== 200) throw refusal(status, body, status === 401 ? null : "Armada gave no secrets");
      const secrets = Array.isArray(body.secrets) ? (body.secrets as Record<string, unknown>[]) : null;
      if (!secrets?.every((s) => typeof s.name === "string" && typeof s.value === "string"))
        throw new ArmadaApiError(`Armada (${host}) answered the secrets in a shape this CLI does not know`);
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((w): w is string => typeof w === "string") : []);
      return {
        project: typeof body.project === "string" ? body.project : project.slug,
        secrets: secrets.map((s) => ({
          name: String(s.name),
          value: String(s.value),
          scope: s.scope === "organization" ? ("organization" as const) : ("project" as const),
        })),
        missing: strings(body.missing),
        warnings: strings(body.warnings),
      };
    },

    async attach(
      signIn: ArmadaSignIn,
      target: {
        project: SecretsProject;
        ticket: string;
        caption: string | null;
        reference: string | null;
        input: { kind: "image"; data: string; contentType: string } | { kind: "link"; url: string };
      },
    ): Promise<{ attachment: Attachment; url: string }> {
      const { status, body } = await call("POST", "attachments", { signIn, body: target });
      if (status !== 200) throw refusal(status, body, "Armada did not attach this item");
      const attachment = body.attachment as Attachment | undefined;
      if (!attachment || typeof attachment.id !== "string" || typeof body.url !== "string")
        throw new ArmadaApiError("Armada answered the attachment in an unknown shape");
      return { attachment, url: body.url };
    },

    /** Sets one secret for workers, for `project` or (scope "organization") every project. The value goes in the body only. */
    async setSecret(
      signIn: ArmadaSignIn,
      target: { project: SecretsProject; name: string; value: string; scope: SecretScope },
    ): Promise<void> {
      const { status, body } = await call("POST", "secrets/set", { signIn, body: target });
      if (status !== 200) throw refusal(status, body, status === 401 ? null : `Armada did not set ${target.name}`);
    },

    /** Unsets one secret for workers; false when it was not set there. */
    async unsetSecret(
      signIn: ArmadaSignIn,
      target: { project: SecretsProject; name: string; scope: SecretScope },
    ): Promise<boolean> {
      const { status, body } = await call("POST", "secrets/unset", { signIn, body: target });
      if (status !== 200) throw refusal(status, body, status === 401 ? null : `Armada did not unset ${target.name}`);
      return body.deleted === true;
    },

    /** A one-time launch token for a worker on `ticket`, valid one hour; the launch message carries it. */
    async launchToken(signIn: ArmadaSignIn, target: { project: string; ticket: string }): Promise<LaunchToken> {
      const { status, body } = await call("POST", "launch-tokens", { signIn, body: target });
      if (status !== 200) throw refusal(status, body, status === 401 ? null : "Armada made no launch token");
      const w = body.worker as LaunchToken["worker"] | undefined;
      if (typeof body.token !== "string" || typeof body.expiresAt !== "string" || !w?.ticket)
        throw new ArmadaApiError(`Armada (${host}) answered the launch token in a shape this CLI does not know`);
      return body as unknown as LaunchToken;
    },

    /**
     * Exchanges a launch token for a worker session; refused when used, expired
     * or revoked. `handle` is the worker's runtime session, when known: Armada
     * shows it if the worker never claims.
     */
    async exchangeLaunchToken(token: string, handle: string | null = null): Promise<WorkerSession> {
      const { status, body } = await call("POST", "launch-tokens/exchange", {
        body: handle ? { token, handle } : { token },
      });
      if (status !== 200) throw refusal(status, body, null);
      const w = body.worker as WorkerSession["worker"] | undefined;
      const org = body.organization as WorkerSession["organization"] | undefined;
      if (typeof body.token !== "string" || !w?.ticket || !w.project || !org?.id)
        throw new ArmadaApiError(`Armada (${host}) answered the launch token in a shape this CLI does not know`);
      return body as unknown as WorkerSession;
    },

    /** Ends the worker sessions of a ticket, once its pull request is merged or it is released; how many ended. */
    async endWorkers(
      signIn: ArmadaSignIn,
      target: { project: string; ticket: string; reason: "merged" | "released"; claimedAt?: string | null },
    ): Promise<number> {
      const { status, body } = await call("POST", "workers/end", { signIn, body: target });
      if (status !== 200) throw refusal(status, body, "Armada did not end the ticket's workers");
      return typeof body.ended === "number" ? body.ended : 0;
    },

    async revokeLaunch(
      signIn: ArmadaSignIn,
      target: { project: string; ticket: string },
    ): Promise<{ id: string; ticket: string }> {
      const { status, body } = await call("POST", "workers/revoke", { signIn, body: target });
      if (status !== 200) throw refusal(status, body, "Armada did not revoke the launch");
      if (typeof body.id !== "string" || typeof body.ticket !== "string")
        throw new ArmadaApiError(`Armada (${host}) answered the revoked launch in a shape this CLI does not know`);
      return { id: body.id, ticket: body.ticket };
    },

    /** Records the runtime session created for this launch, before worker sign-in. */
    async bindLaunch(
      signIn: ArmadaSignIn,
      target: { project: string; ticket: string; id: string; runtime: RuntimeName; handle: string },
    ): Promise<void> {
      const { status, body } = await call("POST", "launch-tokens/bind", { signIn, body: target });
      if (status !== 200) throw refusal(status, body, "Armada did not bind this launch session");
      if (body.id !== target.id || body.ticket !== target.ticket.toUpperCase())
        throw new ArmadaApiError(`Armada (${host}) answered a different bound launch`);
    },

    /** Failure cleanup targets its own launch; older servers safely refuse this distinct route. */
    async revokePendingLaunch(
      signIn: ArmadaSignIn,
      target: { project: string; ticket: string; id: string },
    ): Promise<void> {
      const { status, body } = await call("POST", "workers/revoke-pending", { signIn, body: target });
      if (status !== 200) throw refusal(status, body, "Armada did not revoke this pending launch");
      if (body.id !== target.id || body.ticket !== target.ticket)
        throw new ArmadaApiError(`Armada (${host}) answered a different revoked launch`);
    },

    /** Revokes the session of `armada login` on the server; a worker session ends as released. */
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

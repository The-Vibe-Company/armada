/**
 * The dashboard's server-side client of the Armada control API (`/api/v1/*`), for the operations only the
 * server can do (a golden build needs the encrypted Boat key and the caller's GitHub connection). It runs
 * in server actions with the signed-in user's session token; the token is a request header only and never
 * appears in an error, a result or a log. One request per call: a failed build is reported, never retried.
 */
export class ControlError extends Error {
  override readonly name = "ControlError";
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Options = {
  /** `ARMADA_MCP_URL`; only its origin is used. */
  serverUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** A golden build clones, scans and snapshots; it can take minutes. Same bound as the same-origin proxy. */
  timeoutMs?: number;
};

export type ControlClient = {
  post<T>(route: string, body: Record<string, unknown>): Promise<T>;
};

export function createControlClient(options: Options): ControlClient {
  const origin = originOf(options.serverUrl);
  const doFetch = options.fetch ?? fetch;
  return {
    async post<T>(route: string, body: Record<string, unknown>): Promise<T> {
      if (!origin) throw new ControlError("The Armada server is not configured for this dashboard.");
      let response: Response;
      try {
        response = await doFetch(new URL(`/api/v1/${route}`, origin), {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(options.timeoutMs ?? 660_000),
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
          throw new ControlError(
            "The Armada server did not answer in time. The build may still finish: refresh before trying again.",
          );
        throw new ControlError("The Armada server is unreachable.");
      }
      const parsed = await readJson(response);
      if (response.status === 401)
        throw new ControlError("The Armada server refused this session. Sign in again.", 401);
      if (!response.ok) {
        const failure = isRecord(parsed) ? parsed.error : undefined;
        if (isRecord(failure) && typeof failure.message === "string")
          throw new ControlError(
            failure.message,
            response.status,
            typeof failure.code === "string" ? failure.code : undefined,
          );
        if (typeof failure === "string") throw new ControlError(failure, response.status);
        throw new ControlError(`The Armada server answered ${response.status}.`, response.status);
      }
      return parsed as T;
    },
  };
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type GoldenBuildResult = { name: string; visibility: "org" | "private"; snapshot: string };

export function isGoldenBuildResult(value: unknown): value is GoldenBuildResult {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.snapshot === "string" &&
    (value.visibility === "org" || value.visibility === "private")
  );
}

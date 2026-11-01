import type { GithubCheckpoint } from "./checkpoint.ts";
import type { RawPull } from "./normalize.ts";
import type { RawThread } from "./reviews.ts";

export class GithubReadError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}
export interface HttpOptions {
  endpoint?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}
interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
interface Repository {
  defaultBranchRef?: { name: string; target: { oid: string; statusCheckRollup: { state: string } | null } } | null;
  open?: Connection<RawPull>;
  pullRequest?: (RawPull & { reviewThreads?: Connection<RawThread> }) | null;
}
export class GithubHttp {
  readonly token: string;
  readonly #options: HttpOptions;
  readonly #state: GithubCheckpoint;
  readonly #now: number;
  readonly #baseMs: number;
  constructor(options: HttpOptions, token: string, state: GithubCheckpoint, now: number, baseMs: number) {
    this.#options = options;
    this.token = token;
    this.#state = state;
    this.#now = now;
    this.#baseMs = baseMs;
  }
  get rest(): string {
    const url = new URL(this.#options.endpoint ?? "https://api.github.com/graphql");
    url.pathname = url.pathname.replace(/\/graphql\/?$/, "").replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }
  async request(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
    signal.throwIfAborted();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    headers.set("accept", "application/vnd.github+json");
    const response = await (this.#options.fetch ?? fetch)(url, { ...init, headers, signal, redirect: "error" }).catch(
      () => {
        throw new GithubReadError("GitHub network request failed");
      },
    );
    signal.throwIfAborted();
    const seconds = Number(response.headers.get("x-poll-interval"));
    if (Number.isFinite(seconds) && seconds > 0) this.#state.pollMs = Math.min(seconds * 1000, 86_400_000);
    const retry = response.headers.get("retry-after");
    const retryMs =
      retry === null ? 0 : /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.#now;
    const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000 - this.#now;
    const throttled =
      response.status === 429 ||
      (response.status === 403 && (retry !== null || response.headers.get("x-ratelimit-remaining") === "0"));
    if (throttled) this.#state.backoffMs = Math.min(Math.max(this.#baseMs, this.#state.backoffMs) * 2, 86_400_000);
    if (throttled || retryMs > 0) {
      const delay = Math.max(
        this.#state.backoffMs,
        this.#state.pollMs,
        Number.isFinite(retryMs) ? retryMs : 0,
        response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) ? reset : 0,
      );
      this.#state.pausedUntil = new Date(this.#now + Math.min(delay, 86_400_000)).toISOString();
    }
    if (!response.ok && response.status !== 304)
      throw new GithubReadError(`GitHub answered ${response.status}`, response.status);
    return response;
  }
  async query(query: string, variables: object, signal: AbortSignal): Promise<Repository> {
    const response = await this.request(this.#options.endpoint ?? "https://api.github.com/graphql", signal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await response.json()) as { data?: { repository?: Repository }; errors?: unknown[] };
    signal.throwIfAborted();
    if (!json || json.errors?.length || !json.data?.repository)
      throw new GithubReadError("GitHub returned an incomplete reading");
    return json.data.repository;
  }
  etag(response: Response): string | undefined {
    const value = response.headers.get("etag");
    return value && !value.includes(this.token) ? value : undefined;
  }
  clean(value: string): string {
    return value.replaceAll(this.token, "[redacted]");
  }
}

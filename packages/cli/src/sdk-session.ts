import { AuthError } from "@armada/auth";
import { Armada, ArmadaError } from "@armada/sdk";
import { authClient } from "@armada/sdk/auth";
import type { Session, SessionStore } from "./session.ts";

const DEFAULT_ARMADA_API_URL = "https://armada.thevibecompany.co";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ArmadaApiIo {
  env: NodeJS.ProcessEnv;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  session: SessionStore;
  timeoutMs?: number;
}

export class ArmadaApiError extends AuthError {
  constructor(
    readonly serverCode: string,
    readonly status: number,
    message: string,
    readonly details?: Readonly<{ phase: string }>,
    exitCode?: 1 | 2,
  ) {
    super(
      message,
      exitCode === 2
        ? "usage"
        : exitCode === 1
          ? "unavailable"
          : status === 400
            ? "usage"
            : status === 409 || status === 403
              ? "conflict"
              : "unavailable",
    );
  }
}

export async function authenticatedSession(io: ArmadaApiIo, options: { url?: string; rawJson?: boolean } = {}) {
  const environmentToken = io.env.ARMADA_TOKEN;
  let saved = environmentToken ? null : await io.session.read();
  const origin = await resolveArmadaOrigin(io, options.url, saved);
  const initial = environmentToken || saved?.accessToken;
  if (!initial) throw new AuthError("Set ARMADA_TOKEN or run armada login.", "unauthorized");
  let token = initial;
  const timeoutMs = io.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!environmentToken && saved && Date.parse(saved.expiresAt) - Date.now() <= 60_000) {
    saved = await refresh(origin, io, saved.refreshToken, saved, timeoutMs, undefined, options.rawJson);
    token = saved.accessToken;
  }
  const renewToken = saved
    ? async (signal?: AbortSignal) => {
        if (!saved) throw new Error("No saved login to refresh.");
        saved = await refresh(origin, io, saved.refreshToken, saved, timeoutMs, signal, options.rawJson);
        token = saved.accessToken;
        return token;
      }
    : undefined;
  return { origin, timeoutMs, environmentToken, token: () => token, renewToken };
}

export async function createArmadaSdkReader(io: ArmadaApiIo) {
  const session = await authenticatedSession(io);
  return async <T>(request: (sdk: Armada) => Promise<T>, signal?: AbortSignal) => {
    const call = () =>
      request(
        new Armada({
          url: session.origin,
          token: session.token(),
          fetch: io.fetch,
          ...(io.timeoutMs === undefined ? {} : { timeoutMs: io.timeoutMs }),
        }),
      );
    try {
      try {
        return await call();
      } catch (error) {
        if (!(error instanceof ArmadaError) || error.status !== 401 || !session.renewToken) throw error;
        await session.renewToken(signal);
        return await call();
      }
    } catch (error) {
      if (!(error instanceof ArmadaError)) throw error;
      if (error.status === 401) throw new AuthError("Run armada login or update ARMADA_TOKEN.", "unauthorized");
      throw new ArmadaApiError(error.serverCode ?? error.code, error.status, error.message);
    }
  };
}

async function refresh(
  origin: string,
  io: ArmadaApiIo,
  refreshToken: string,
  saved: NonNullable<Awaited<ReturnType<SessionStore["read"]>>>,
  timeoutMs: number,
  signal?: AbortSignal,
  safeErrors = false,
) {
  const operation = async (store: SessionStore) => {
    const current = await store.read();
    if (
      !current ||
      current.loginId !== saved.loginId ||
      armadaApiUrl(current.armadaUrl) !== armadaApiUrl(saved.armadaUrl)
    )
      throw new AuthError("The saved login changed; retry this command with the intended Armada URL.", "unauthorized");
    if (
      (current.refreshToken !== refreshToken || current.accessToken !== saved.accessToken) &&
      Date.parse(current.expiresAt) - Date.now() > 60_000
    )
      return current;
    return refreshLocked(origin, io, store, current, timeoutMs, signal, safeErrors);
  };
  return io.session.withLock ? io.session.withLock(operation) : operation(io.session);
}

async function refreshLocked(
  origin: string,
  io: ArmadaApiIo,
  store: SessionStore,
  saved: NonNullable<Awaited<ReturnType<SessionStore["read"]>>>,
  timeoutMs: number,
  signal?: AbortSignal,
  safeErrors = false,
) {
  const result = await authClient(origin, (input, init) => io.fetch(input, init)).refresh(
    saved.refreshToken,
    timeoutMs,
    signal,
  );
  if (result.kind === "transport") throw new AuthError("Armada could not reach the server.", "unavailable");
  const { response, payload } = result;
  const value = payload as {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
    error?: { code?: string; message?: string };
  } | null;
  if (!response.ok) {
    if (
      !safeErrors &&
      value?.error &&
      typeof value.error.message === "string" &&
      ["usage", "unauthorized", "unavailable"].includes(value.error.code ?? "")
    )
      throw new AuthError(value.error.message, value.error.code as "usage" | "unauthorized" | "unavailable");
    if (response.status === 401 || response.status === 403)
      throw new AuthError("Your session was refused by the sign-in service. Run armada login again.", "unauthorized");
    throw new AuthError(
      "Session renewal could not finish because Armada could not complete the request. Try again later.",
      "unavailable",
    );
  }
  if (
    !value ||
    typeof value.accessToken !== "string" ||
    typeof value.refreshToken !== "string" ||
    typeof value.expiresAt !== "string"
  )
    throw new AuthError(
      "Session renewal could not finish because Armada returned an invalid session. Try signing in again; if this continues, contact the server operator.",
      "unavailable",
    );
  const updated = {
    ...saved,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
  };
  await store.write(updated);
  return updated;
}

export async function resolveArmadaOrigin(
  io: Pick<ArmadaApiIo, "env" | "session">,
  url?: string,
  saved?: Session | null,
) {
  const explicit = url ?? io.env.ARMADA_URL;
  if (io.env.ARMADA_TOKEN) return armadaApiUrl(explicit);
  const login = saved === undefined ? await io.session.read() : saved;
  const bound = armadaApiUrl(login?.armadaUrl);
  if (login && explicit !== undefined && armadaApiUrl(explicit) !== bound)
    throw new AuthError(
      "Saved login belongs to another server. Choose its server or run armada login --url <server-origin>.",
      "usage",
    );
  return login ? bound : armadaApiUrl(explicit);
}

export function armadaApiUrl(value: string | undefined) {
  const address = value || DEFAULT_ARMADA_API_URL;
  try {
    const url = new URL(address.includes("://") ? address : `https://${address}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    return url.origin;
  } catch {
    throw new AuthError("Use an HTTP(S) Armada API URL.", "usage");
  }
}

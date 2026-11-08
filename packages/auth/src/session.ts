import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AuthError } from "./errors.ts";

/** The CLI's Supabase session. It lives on this machine, never in the database. */
export interface Session {
  supabaseUrl: string;
  /** Public discovery settings saved with the login, for later CLI invocations. */
  anonKey?: string;
  armadaUrl?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
}

export interface SessionStore {
  read(): Promise<Session | null>;
  write(session: Session): Promise<void>;
  clear(): Promise<void>;
}

export function memorySessionStore(initial: Session | null = null): SessionStore {
  let current = initial;
  return {
    read: async () => current,
    write: async (session) => {
      current = session;
    },
    clear: async () => {
      current = null;
    },
  };
}

/** `~/.config/armada/session.json`, mode 0600. Tests pass a path under a temporary directory. */
export function fileSessionStore(path: string): SessionStore {
  return {
    async read() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (isNotFound(error)) return null;
        throw new AuthError("Armada could not read the saved login.", "unavailable");
      }
      return parseSession(text);
    },
    async write(session) {
      const directory = dirname(path);
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o700);
      const temporary = join(directory, `.${basename(path)}.${crypto.randomUUID()}.tmp`);
      try {
        await writeFile(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}

/**
 * Returns a session that is still valid for at least a minute.
 * `refresh` is called only when it is not, and the new session is stored.
 */
export async function ensureFreshSession(
  store: SessionStore,
  now: Date,
  refresh: (session: Session) => Promise<Session>,
): Promise<Session> {
  const session = await store.read();
  if (!session) throw new AuthError("Run armada login.", "unauthorized");
  if (isFresh(session, now)) return session;
  return refreshSession(store, now, refresh, session);
}

/**
 * Refresh a saved session after a rejected request. If another CLI invocation has already rotated
 * the refresh token, use its saved session instead of attempting to consume the stale token.
 */
export async function refreshSession(
  store: SessionStore,
  _now: Date,
  refresh: (session: Session) => Promise<Session>,
  rejected?: Session,
): Promise<Session> {
  const current = await store.read();
  if (!current) throw new AuthError("Run armada login.", "unauthorized");
  if (rejected && current.refreshToken !== rejected.refreshToken) return current;
  const next = await refresh(current);
  const latest = await store.read();
  if (latest && latest.refreshToken !== current.refreshToken) return latest;
  await store.write(next);
  return next;
}

export function isFresh(session: Session, now: Date): boolean {
  const expires = Date.parse(session.expiresAt);
  return !Number.isNaN(expires) && expires - now.getTime() > 60_000;
}

function parseSession(text: string): Session {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AuthError("Run armada login again.", "unauthorized");
  }
  if (!isRecord(value)) throw new AuthError("Run armada login again.", "unauthorized");
  const { supabaseUrl, accessToken, refreshToken, expiresAt, userId } = value;
  if (
    typeof supabaseUrl !== "string" ||
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    typeof expiresAt !== "string" ||
    typeof userId !== "string"
  ) {
    throw new AuthError("Run armada login again.", "unauthorized");
  }
  if (
    (value.anonKey !== undefined && typeof value.anonKey !== "string") ||
    (value.armadaUrl !== undefined && typeof value.armadaUrl !== "string")
  ) {
    throw new AuthError("Run armada login again.", "unauthorized");
  }
  return {
    supabaseUrl,
    accessToken,
    refreshToken,
    expiresAt,
    userId,
    ...(typeof value.anonKey === "string" ? { anonKey: value.anonKey } : {}),
    ...(typeof value.armadaUrl === "string" ? { armadaUrl: value.armadaUrl } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

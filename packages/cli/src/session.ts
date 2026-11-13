import { Database } from "bun:sqlite";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AuthError } from "@armada/auth";

/** The CLI's Armada API session. It is local-only and never contains provider configuration. */
export interface Session {
  /** Identifies a login independently of its rotating access and refresh tokens. */
  loginId?: string;
  armadaUrl?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export interface SessionStore {
  read(): Promise<Session | null>;
  write(session: Session): Promise<void>;
  clear(): Promise<void>;
  /** Serialize a read/refresh/write transaction, including across processes for file stores. */
  withLock?<T>(operation: (store: SessionStore) => Promise<T>): Promise<T>;
}

export function memorySessionStore(initial: Session | null = null): SessionStore {
  let current = initial;
  let pending: Promise<unknown> = Promise.resolve();
  const store: SessionStore = {
    read: async () => current,
    write: async (session) => {
      current = session;
    },
    clear: async () => {
      current = null;
    },
    withLock(operation) {
      const result = pending.then(() => operation(store));
      pending = result.catch(() => undefined);
      return result;
    },
  };
  return store;
}

/** `~/.config/armada/session.json`, mode 0600. */
export function fileSessionStore(path: string): SessionStore {
  const unlocked: SessionStore = {
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
  const withLock = async <T>(operation: (store: SessionStore) => Promise<T>): Promise<T> => {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // SQLite supplies a portable OS lock, released even if the CLI crashes. No tokens
    // are stored here. Never unlink this file: another process may already have it open.
    const lockPath = `${path}.lock.sqlite`;
    const lock = new Database(lockPath, { create: true });
    try {
      await chmod(lockPath, 0o600);
      const deadline = Date.now() + 15_000;
      while (true) {
        try {
          lock.exec("BEGIN EXCLUSIVE");
          break;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "SQLITE_BUSY") throw error;
          if (Date.now() >= deadline)
            throw new AuthError("Another Armada process is updating the login; retry this command.", "unavailable");
          await Bun.sleep(20);
        }
      }
      return await operation(unlocked);
    } finally {
      lock.close();
    }
  };
  return {
    read: unlocked.read,
    write: (session) => withLock((store) => store.write(session)),
    clear: () => withLock((store) => store.clear()),
    withLock,
  };
}

function parseSession(text: string): Session {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AuthError("Run armada login again.", "unauthorized");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthError("Run armada login again.", "unauthorized");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.accessToken !== "string" ||
    typeof record.refreshToken !== "string" ||
    typeof record.expiresAt !== "string" ||
    (record.armadaUrl !== undefined && typeof record.armadaUrl !== "string") ||
    (record.loginId !== undefined && typeof record.loginId !== "string")
  ) {
    throw new AuthError("Run armada login again.", "unauthorized");
  }
  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    expiresAt: record.expiresAt,
    ...(typeof record.armadaUrl === "string" ? { armadaUrl: record.armadaUrl } : {}),
    ...(typeof record.loginId === "string" ? { loginId: record.loginId } : {}),
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

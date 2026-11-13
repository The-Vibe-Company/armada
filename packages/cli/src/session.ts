import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AuthError } from "@armada/auth";

/** The CLI's Armada API session. It is local-only and never contains provider configuration. */
export interface Session {
  armadaUrl?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
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

/** `~/.config/armada/session.json`, mode 0600. */
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
    (record.armadaUrl !== undefined && typeof record.armadaUrl !== "string")
  ) {
    throw new AuthError("Run armada login again.", "unauthorized");
  }
  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    expiresAt: record.expiresAt,
    ...(typeof record.armadaUrl === "string" ? { armadaUrl: record.armadaUrl } : {}),
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

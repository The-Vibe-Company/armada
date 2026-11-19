export interface Session {
  supabaseUrl: string;
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

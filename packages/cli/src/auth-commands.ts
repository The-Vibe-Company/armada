import { homedir } from "node:os";
import { join } from "node:path";
import {
  AuthError,
  type AuthFetch,
  type AuthStore,
  createServiceToken,
  createUserStore,
  ensureFreshSession,
  fileSessionStore,
  listServiceTokens,
  loginWithBrowser,
  type Provider,
  refreshSupabaseSession,
  revokeServiceToken,
  type SessionStore,
} from "@armada/auth";

export interface AuthIo {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  fetch: AuthFetch;
  now: () => Date;
  open: (url: string) => void;
  session: SessionStore;
  /** Set by tests. The CLI otherwise talks to PostgREST with the user's JWT. */
  store?: AuthStore;
  timeoutMs?: number;
}

export function defaultSessionPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "armada", "session.json");
}

export function productionAuthIo(
  io: { out: AuthIo["out"]; err: AuthIo["err"] },
  env: NodeJS.ProcessEnv = process.env,
): AuthIo {
  return {
    ...io,
    env,
    fetch: globalThis.fetch,
    now: () => new Date(),
    open: openBrowser,
    session: fileSessionStore(defaultSessionPath(env)),
  };
}

export async function loginCommand(io: AuthIo, provider: Provider | undefined): Promise<void> {
  const supabaseUrl = required(io.env, "SUPABASE_URL");
  const anonKey = required(io.env, "SUPABASE_ANON_KEY");
  const result = await loginWithBrowser({
    fetch: io.fetch,
    supabaseUrl,
    anonKey,
    open: io.open,
    session: io.session,
    now: io.now,
    ...(provider ? { provider } : {}),
    ...(io.timeoutMs !== undefined ? { timeoutMs: io.timeoutMs } : {}),
    onUrl: (url) => io.err(`Opening a browser. If it does not open, visit ${url}\n`),
  });
  io.out(`Logged in.\nuser: ${result.userId}\n`);
}

export async function logoutCommand(io: AuthIo): Promise<void> {
  await io.session.clear();
  io.out("Logged out.\n");
}

export async function tokenCreate(io: AuthIo, orgName: string | undefined, label: string | undefined): Promise<void> {
  const store = await userStore(io);
  const session = await io.session.read();
  if (!session) throw new AuthError("Run armada login.", "unauthorized");
  const created = await createServiceToken(store, {
    userId: session.userId,
    now: io.now(),
    ...(orgName !== undefined ? { orgName } : {}),
    ...(label !== undefined ? { label } : {}),
  });
  io.out(
    `Created a service token. Copy it now; Armada stores only its hash.\n\nid: ${created.id}\nlabel: ${created.label}\norg: ${created.orgName}\ntoken: ${created.token}\n`,
  );
}

export async function tokenList(io: AuthIo): Promise<void> {
  const store = await userStore(io);
  const session = await io.session.read();
  if (!session) throw new AuthError("Run armada login.", "unauthorized");
  const tokens = await listServiceTokens(store, session.userId);
  if (tokens.length === 0) {
    io.out("No service tokens.\n");
    return;
  }
  for (const token of tokens) {
    const state = token.revokedAt ? "revoked" : "active";
    io.out(`${token.id}  ${token.label}  ${token.orgName}  ${state}  ${token.createdAt}\n`);
  }
}

export async function tokenRevoke(io: AuthIo, id: string): Promise<void> {
  const store = await userStore(io);
  const session = await io.session.read();
  if (!session) throw new AuthError("Run armada login.", "unauthorized");
  await revokeServiceToken(store, { userId: session.userId, id, now: io.now() });
  io.out(`Revoked ${id}.\n`);
}

async function userStore(io: AuthIo): Promise<AuthStore> {
  if (io.store) {
    await ensureFreshSession(io.session, io.now(), async (session) => session);
    return io.store;
  }
  const anonKey = required(io.env, "SUPABASE_ANON_KEY");
  const session = await ensureFreshSession(io.session, io.now(), (current) =>
    refreshSupabaseSession({ fetch: io.fetch, anonKey, session: current, now: io.now() }),
  );
  return createUserStore({
    fetch: io.fetch,
    supabaseUrl: session.supabaseUrl,
    anonKey,
    accessToken: session.accessToken,
  });
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new AuthError(`Set ${name}.`, "usage");
  return value;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

export type { Provider };

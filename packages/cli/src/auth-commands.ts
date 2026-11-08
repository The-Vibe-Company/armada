import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
  loginWithEmail,
  type Provider,
  refreshSession,
  refreshSupabaseSession,
  revokeServiceToken,
  type Session,
  type SessionStore,
} from "@armada/auth";

import { DEFAULT_ARMADA_URL, discoverClientConfig } from "./client-config.ts";

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
  /** Reads the code typed from a sign-in email. Tests set it; the terminal prompt is the default. */
  readCode?: (signal: AbortSignal) => Promise<string>;
  readEmail?: () => Promise<string>;
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
    readCode: promptCode,
    readEmail: () =>
      new Promise((resolve) => {
        const lines = createInterface({ input: process.stdin, output: process.stderr });
        lines.question("Email: ", (answer) => {
          lines.close();
          resolve(answer.trim());
        });
      }),
  };
}

/** One line from the terminal, so a code can be typed while the link is also waiting. */
function promptCode(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: process.stdin, output: process.stderr });
    const stop = () => {
      lines.close();
      reject(new Error("Stopped reading the code."));
    };
    signal.addEventListener("abort", stop, { once: true });
    lines.question("Code from the email (or click its link): ", (answer) => {
      signal.removeEventListener("abort", stop);
      lines.close();
      resolve(answer);
    });
  });
}

export async function loginCommand(
  io: AuthIo,
  how: { provider?: Provider | undefined; email?: string | undefined; url?: string | undefined } = {},
): Promise<void> {
  let { provider } = how;
  let email = how.email;
  // Explicit legacy settings remain available for local setups without discovery.
  const legacy = !how.url && !io.env.ARMADA_URL && io.env.SUPABASE_URL && io.env.SUPABASE_ANON_KEY;
  const config = legacy
    ? {
        supabaseUrl: required(io.env, "SUPABASE_URL"),
        anonKey: required(io.env, "SUPABASE_ANON_KEY"),
        providers: ["github", "google"],
      }
    : await discoverClientConfig(io, how.url ?? io.env.ARMADA_URL ?? DEFAULT_ARMADA_URL);
  const { supabaseUrl, anonKey } = config;
  const armadaUrl = "controlUrl" in config ? config.controlUrl : undefined;
  if (provider && !config.providers.includes(provider)) {
    throw new AuthError(`This server does not enable ${provider} login. Use --email <address>.`, "usage");
  }
  if (!provider && email === undefined && config.providers.length === 0) {
    if (!io.readEmail) throw new AuthError("Sign in with --email <address>.", "usage");
    email = await io.readEmail();
  }
  if (!provider && config.providers.length === 1) provider = config.providers[0] as Provider;
  const session: SessionStore = {
    ...io.session,
    write: (value) => io.session.write({ ...value, anonKey, ...(armadaUrl ? { armadaUrl } : {}) }),
  };
  if (email !== undefined) {
    const result = await loginWithEmail({
      fetch: io.fetch,
      supabaseUrl,
      anonKey,
      email,
      session,
      now: io.now,
      ...(io.readCode ? { readCode: io.readCode } : {}),
      ...(io.timeoutMs !== undefined ? { timeoutMs: io.timeoutMs } : {}),
      onSent: (sent) =>
        io.err(
          `Sent a sign-in email to ${sent}. Click the link in it${io.readCode ? ", or type the code it contains" : ""}.\n`,
        ),
      onWrongCode: () => io.err("That code was refused. Try again.\n"),
    });
    io.out(`Logged in.\nuser: ${result.userId}\n`);
    return;
  }
  const result = await loginWithBrowser({
    fetch: io.fetch,
    supabaseUrl,
    anonKey,
    open: io.open,
    session,
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

/** The signed-in session, refreshed when it is about to expire. The one identity every command acts as. */
export async function signedIn(io: AuthIo): Promise<{ session: Session; anonKey: string }> {
  const saved = await io.session.read();
  if (!saved) throw new AuthError("Run armada login.", "unauthorized");
  const anonKey = saved.anonKey ?? required(io.env, "SUPABASE_ANON_KEY");
  const session = await ensureFreshSession(io.session, io.now(), (current) => refresh(io, anonKey, current));
  return { session, anonKey };
}

/** Rotate the saved session after a rejected bearer request. */
export async function refreshSignedIn(io: AuthIo, rejected: Session): Promise<Session> {
  const anonKey = rejected.anonKey ?? required(io.env, "SUPABASE_ANON_KEY");
  return refreshSession(io.session, io.now(), (current) => refresh(io, anonKey, current), rejected);
}

async function refresh(io: AuthIo, anonKey: string, session: Session): Promise<Session> {
  return { ...session, ...(await refreshSupabaseSession({ fetch: io.fetch, anonKey, session, now: io.now() })) };
}

async function userStore(io: AuthIo): Promise<AuthStore> {
  if (io.store) {
    await ensureFreshSession(io.session, io.now(), async (session) => session);
    return io.store;
  }
  const { session, anonKey } = await signedIn(io);
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

import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  AuthError,
  assertEmail,
  createPkce,
  type AuthFetch,
  type Provider,
} from "@armada/auth";

import { DEFAULT_ARMADA_API_URL, createArmadaApiClient } from "./armada-api.ts";
import { browserLogin } from "./browser-login.ts";
import { fileSessionStore, type SessionStore } from "./session.ts";

export interface AuthIo {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  fetch: AuthFetch;
  now: () => Date;
  open: (url: string) => void;
  session: SessionStore;
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
  if (how.email !== undefined) {
    const origin = how.url ?? io.env.ARMADA_URL ?? DEFAULT_ARMADA_API_URL;
    const email = assertEmail(how.email);
    const pkce = await createPkce();
    const state = crypto.randomUUID().replaceAll("-", "");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Not found", { status: 404 }) });
    const callback = `http://127.0.0.1:${server.port}/callback`;
    const start = await io.fetch(new URL("/api/v1/auth/email/start", origin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, redirect_uri: callback, code_challenge: pkce.challenge, state }) });
    try {
      if (!start.ok) throw new AuthError("Armada could not start email login.", "unauthorized");
      io.err(`Sent a sign-in email to ${email}. Type the code it contains.\n`);
      if (!io.readCode) throw new AuthError("Email code input is unavailable.", "usage");
      const code = await io.readCode(new AbortController().signal);
      const response = await io.fetch(new URL("/api/v1/auth/email/verify", origin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
      const value = await response.json().catch(() => null) as { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown } | null;
      if (!response.ok || !value || typeof value.accessToken !== "string" || typeof value.refreshToken !== "string" || typeof value.expiresAt !== "string") throw new AuthError("Email code was refused.", "unauthorized");
      await io.session.write({ armadaUrl: origin, accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt });
      io.out("Logged in.\n");
      return;
    } finally {
      await server.stop(false);
    }
  }
  // Browser login is Armada-hosted: the CLI never contacts a native provider.
  if (how.email === undefined) {
    const provider = how.provider ?? "github";
    const origin = how.url ?? io.env.ARMADA_URL ?? DEFAULT_ARMADA_API_URL;
    try {
      const result = await browserLogin({
        origin,
        provider,
        fetch: io.fetch as typeof fetch,
        open: io.open,
        ...(io.timeoutMs === undefined ? {} : { timeoutMs: io.timeoutMs }),
      });
      await io.session.write({
        armadaUrl: origin,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
      });
      io.out("Logged in.\n");
      return;
    } catch {
      throw new AuthError("Armada browser login failed.", "unauthorized");
    }
  }
  throw new AuthError("Sign in with --provider github or google.", "usage");
}

export async function logoutCommand(io: AuthIo): Promise<void> {
  await io.session.clear();
  io.out("Logged out.\n");
}

export async function tokenCreate(io: AuthIo, orgName: string | undefined, label: string | undefined): Promise<void> {
  const client = await createArmadaApiClient(io);
  const created = await client.request<{ id: string; label: string; orgName: string; token: string }>("/api/v1/token/create", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    ...(orgName !== undefined ? { orgName } : {}),
    ...(label !== undefined ? { label } : {}),
  }) });
  io.out(
    `Created a service token. Copy it now; Armada stores only its hash.\n\nid: ${created.id}\nlabel: ${created.label}\norg: ${created.orgName}\ntoken: ${created.token}\n`,
  );
}

export async function tokenList(io: AuthIo): Promise<void> {
  const client = await createArmadaApiClient(io);
  const { tokens } = await client.request<{ tokens: { id: string; label: string; orgName: string; createdAt: string; revokedAt: string | null }[] }>("/api/v1/token/list", { method: "POST" });
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
  const client = await createArmadaApiClient(io);
  await client.request("/api/v1/token/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
  io.out(`Revoked ${id}.\n`);
}


function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

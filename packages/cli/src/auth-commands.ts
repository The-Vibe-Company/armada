import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { AuthError, type AuthFetch, assertEmail, createPkce, type Provider } from "@armada/auth";
import { createArmadaApiClient, DEFAULT_ARMADA_API_URL } from "./armada-api.ts";
import { browserLogin } from "./browser-login.ts";
import { filePreferences, type Preferences } from "./preferences.ts";
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
  preferences?: Preferences;
  sleep?: (ms: number) => Promise<void>;
  /** Reads the code typed from a sign-in email. Tests set it; the terminal prompt is the default. */
  readCode?: (signal: AbortSignal) => Promise<string>;
  readEmail?: (defaultEmail?: string) => Promise<string>;
  interactive?: boolean;
  confirmSignIn?: () => Promise<boolean>;
  chooseMethod?: (methods: string[], defaultMethod: string) => Promise<string>;
  emailPreferences?: Preferences;
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
    preferences: filePreferences(join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "armada", "preferences.json")),
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY && !env.CI),
    confirmSignIn: async () => /^(y|yes)?$/i.test(await promptLine("You are not signed in. Sign in now? [Y/n] ")),
    chooseMethod: async (methods, defaultMethod) => {
      const choice = await promptLine(`Sign-in method (${methods.join(", ")}) [${defaultMethod}]: `);
      return choice || defaultMethod;
    },
    emailPreferences: filePreferences(
      join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "armada", "login-email.json"),
    ),
    readCode: promptCode,
    readEmail: (previous) => promptLine("Email: ", previous),
  };
}

/** Terminal-only prompts never consume piped command input. */
function promptLine(question: string, initial = ""): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new AuthError("Run armada login --email <address> in an interactive terminal.", "usage");
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin, output: process.stderr });
    lines.question(question, (answer) => {
      lines.close();
      resolve(answer.trim());
    });
    if (initial) lines.write(initial);
  });
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
    lines.question("Code from the email (do not open its link first): ", (answer) => {
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
  const origin = how.url ?? io.env.ARMADA_URL ?? DEFAULT_ARMADA_API_URL;
  if (how.email === undefined) {
    let methods: string[];
    try {
      const response = await io.fetch(new URL("/api/v1/auth/methods", origin), {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
      const value = (await response.json()) as { methods?: unknown };
      if (
        !response.ok ||
        !Array.isArray(value.methods) ||
        !value.methods.every((method) => ["email", "github", "google"].includes(method))
      )
        throw new Error();
      methods = value.methods;
    } catch {
      throw new AuthError("Could not discover enabled sign-in methods; try again later.", "unavailable");
    }
    if (how.provider && !methods.includes(how.provider))
      throw new AuthError(
        `${how.provider} sign-in is not enabled; enabled methods: ${methods.join(", ") || "none"}.`,
        "usage",
      );
    if (!how.provider) {
      // A remembered email makes code login shortest; otherwise an enabled browser method needs no typing.
      const previous = await io.emailPreferences?.read(origin);
      const defaultMethod =
        previous && methods.includes("email")
          ? "email"
          : (methods.find((method) => method === "github" || method === "google") ?? methods[0]);
      if (!defaultMethod) throw new AuthError("No supported sign-in methods are enabled.", "unavailable");
      const method =
        methods.length > 1 && io.chooseMethod ? await io.chooseMethod(methods, defaultMethod) : defaultMethod;
      if (!methods.includes(method)) throw new AuthError("Choose one of the enabled sign-in methods.", "usage");
      if (method === "email") {
        if (!io.readEmail) throw new AuthError("Use armada login --email <address>.", "usage");
        how = { ...how, email: await io.readEmail(previous) };
      } else {
        how = { ...how, provider: method as Provider };
      }
    }
  }
  if (how.email !== undefined) {
    const email = assertEmail(how.email);
    const pkce = await createPkce();
    const state = crypto.randomUUID().replaceAll("-", "");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("Not found", { status: 404 }),
    });
    const callback = `http://127.0.0.1:${server.port}/callback`;
    const start = await io.fetch(new URL("/api/v1/auth/email/start", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, redirect_uri: callback, code_challenge: pkce.challenge, state }),
    });
    try {
      if (!start.ok) throw new AuthError("Armada could not start email login.", "unauthorized");
      io.err(`Sent a sign-in email to ${email}. Type the code it contains.\n`);
      if (!io.readCode) throw new AuthError("Email code input is unavailable.", "usage");
      const code = await io.readCode(new AbortController().signal);
      const response = await io.fetch(new URL("/api/v1/auth/email/verify", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const value = (await response.json().catch(() => null)) as {
        accessToken?: unknown;
        refreshToken?: unknown;
        expiresAt?: unknown;
      } | null;
      if (
        !response.ok ||
        !value ||
        typeof value.accessToken !== "string" ||
        typeof value.refreshToken !== "string" ||
        typeof value.expiresAt !== "string"
      )
        throw new AuthError(
          "Could not verify this code. It may be incorrect, expired, or already used. Opening the email link uses up the code. Request a new code and enter it without opening the link.",
          "unauthorized",
        );
      await io.session.write({
        armadaUrl: origin,
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        expiresAt: value.expiresAt,
      });
      await io.emailPreferences?.write(origin, email);
      io.out("Logged in.\n");
      return;
    } finally {
      await server.stop(false);
    }
  }
  // Browser login is Armada-hosted: the CLI never contacts a native provider.
  if (how.email === undefined) {
    const provider = how.provider as Provider;
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

export async function tokenCreate(
  io: AuthIo,
  orgName: string | undefined,
  label: string | undefined,
  json = false,
): Promise<void> {
  const client = await createArmadaApiClient(io);
  const created = await client.request<{ id: string; label: string; orgName: string; token: string }>(
    "/api/v1/token/create",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(orgName !== undefined ? { orgName } : {}),
        ...(label !== undefined ? { label } : {}),
      }),
    },
  );
  if (json) {
    io.out(`${JSON.stringify(created)}\n`);
    return;
  }
  io.out(
    `Created a service token. Copy it now; Armada stores only its hash.\n\nid: ${created.id}\nlabel: ${created.label}\norg: ${created.orgName}\ntoken: ${created.token}\n`,
  );
}

export async function tokenList(io: AuthIo, json = false): Promise<void> {
  const client = await createArmadaApiClient(io);
  const { tokens } = await client.request<{
    tokens: { id: string; label: string; orgName: string; createdAt: string; revokedAt: string | null }[];
  }>("/api/v1/token/list", { method: "POST" });
  if (json) {
    io.out(`${JSON.stringify({ tokens })}\n`);
    return;
  }
  if (tokens.length === 0) {
    io.out("No service tokens.\n");
    return;
  }
  for (const token of tokens) {
    const state = token.revokedAt ? "revoked" : "active";
    io.out(`${token.id}  ${token.label}  ${token.orgName}  ${state}  ${token.createdAt}\n`);
  }
}

export async function tokenRevoke(io: AuthIo, id: string, json = false): Promise<void> {
  const client = await createArmadaApiClient(io);
  await client.request("/api/v1/token/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  io.out(json ? `${JSON.stringify({ ok: true })}\n` : `Revoked ${id}.\n`);
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

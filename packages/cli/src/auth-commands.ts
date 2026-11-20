import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { AuthError, type AuthFetch } from "@armada/auth";
import { publicAuthOperations } from "@armada/core/contract/public-auth";
import { armadaApiUrl } from "./armada-api.ts";
import type { Preferences } from "./preferences.ts";
import { profileStores } from "./profiles.ts";
import type { SessionStore } from "./session.ts";

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
  interactive?: boolean;
  confirmSignIn?: () => Promise<boolean>;
  launchPreferences?: Preferences;
  chooseLaunch?: (title: string, options: { value: string; label: string }[], preferred?: string) => Promise<string>;
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
    ...profileStores(env),
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY && !env.CI),
    confirmSignIn: async () => /^(y|yes)?$/i.test(await promptLine("You are not signed in. Sign in now? [Y/n] ")),
    chooseLaunch: async (title, options, preferred) => {
      io.err(
        `${title}:\n${options.map((o, i) => `  ${i + 1}. ${o.label}${o.value === preferred ? " (default)" : ""}`).join("\n")}\n`,
      );
      const answer = await promptLine("Choose a number (Enter for default): ");
      return answer ? (options[Number(answer) - 1]?.value ?? "") : (preferred ?? "");
    },
  };
}

function promptLine(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new AuthError("Run this command in an interactive terminal.", "usage");
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin, output: process.stderr });
    lines.question(question, (answer) => {
      lines.close();
      resolve(answer.trim());
    });
  });
}

export async function loginCommand(io: AuthIo, how: { url?: string | undefined; json?: boolean } = {}): Promise<void> {
  const origin = armadaApiUrl(how.url ?? io.env.ARMADA_URL);
  const { authDeviceStart, authDevicePoll } = publicAuthOperations;
  const post = async (path: string, body: unknown) => {
    try {
      const response = await io.fetch(new URL(path, origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(io.timeoutMs ?? 35_000),
      });
      if (response.status === 429)
        throw new AuthError("Too many CLI login requests. Try again in a minute.", "rate_limited");
      if (!response.ok) throw new Error();
      return await response.json();
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError("Armada sign-in could not complete. Start a new login.", "unavailable");
    }
  };
  const start = authDeviceStart.output.safeParse(
    await post(authDeviceStart.route.path, {
      hostname:
        hostname()
          .replace(/[^a-zA-Z0-9_.-]/g, "_")
          .slice(0, 253) || "unknown",
    }),
  );
  if (!start.success) throw new AuthError("Armada returned an invalid login request.", "unavailable");
  const { device_code, user_code, verification_uri_complete, expires_in } = start.data;
  const verification = new URL(verification_uri_complete);
  const local =
    verification.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(verification.hostname);
  if ((!local && verification.protocol !== "https:") || verification.username || verification.password)
    throw new AuthError("Armada returned an unsafe browser link.", "unavailable");

  const deadline = io.now().getTime() + expires_in * 1000;
  const sleep = io.sleep ?? Bun.sleep;
  let interval = start.data.interval;
  if (how.json) {
    const handoff = {
      verificationUrl: verification.href,
      userCode: user_code,
      expiresAt: new Date(deadline).toISOString(),
    };
    io.out(`${JSON.stringify(handoff)}\n`);
  } else {
    io.err(`Open ${verification.href} and confirm code ${user_code}.\n`);
    try {
      io.open(verification.href);
    } catch {}
  }

  while (io.now().getTime() < deadline) {
    await sleep(Math.min(interval * 1000, deadline - io.now().getTime()));
    if (io.now().getTime() >= deadline) break;
    const poll = authDevicePoll.output.safeParse(await post(authDevicePoll.route.path, { device_code }));
    if (!poll.success) throw new AuthError("Armada returned an invalid login response.", "unavailable");
    const result = poll.data;
    switch (result.status) {
      case "authorization_pending":
      case "slow_down":
        interval = result.interval;
        continue;
      case "access_denied":
        throw new AuthError("CLI sign-in was denied in the browser.", "unauthorized");
      case "expired_token":
        throw new AuthError("This CLI login expired or was already used. Run armada login again.", "unauthorized");
      case "authorized": {
        const { accessToken, refreshToken, expiresAt, email } = result;
        await io.session.write({
          loginId: crypto.randomUUID(),
          armadaUrl: origin,
          accessToken,
          refreshToken,
          expiresAt,
        });
        const account = email.replace(/[\p{Cc}\p{Cf}]/gu, "");
        io.out(how.json ? '{"authenticated":true}\n' : `Signed in as ${account}.\n`);
        return;
      }
    }
  }
  throw new AuthError("This CLI login expired. Run armada login again.", "unauthorized");
}

export async function logoutCommand(io: AuthIo, json = false): Promise<void> {
  await io.session.clear();
  io.out(json ? '{"authenticated":false}\n' : "Logged out.\n");
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

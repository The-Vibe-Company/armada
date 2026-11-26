import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { AuthError, type AuthFetch } from "@armada/auth";
import { organizationOperations } from "@armada/core/contract";
import { publicAuthOperations } from "@armada/core/contract/public-auth";
import { authClient } from "@armada/sdk/auth";
import type { Preferences } from "./preferences.ts";
import { profileStores } from "./profiles.ts";
import { armadaApiUrl } from "./sdk-session.ts";
import type { Session, SessionStore } from "./session.ts";

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

type AuthResponse = Awaited<ReturnType<ReturnType<typeof authClient>["startDevice"]>>;

function loginPayload(result: AuthResponse): unknown {
  if (result.kind === "response") {
    if (result.response.status === 429)
      throw new AuthError("Too many CLI login requests. Try again in a minute.", "rate_limited");
    if (result.response.ok && !result.bodyReadFailed) return result.payload;
  }
  throw new AuthError("Armada sign-in could not complete. Start a new login.", "unavailable");
}

export function resolveOrgReference<T extends { id: string; name: string }>(orgs: readonly T[], ref: string) {
  const matches = orgs.filter(
    (entry) => entry.id.toLowerCase() === ref.toLowerCase() || entry.name.toLowerCase() === ref.toLowerCase(),
  );
  if (matches.length !== 1 || !matches[0])
    throw new AuthError("Choose one of your organizations by UUID or exact name.", "usage");
  return matches[0];
}

export async function loginCommand(
  io: AuthIo,
  how: { url?: string | undefined; json?: boolean; org?: string | undefined } = {},
): Promise<void> {
  const preferences = io.preferences;
  if (how.org !== undefined && !preferences)
    throw new AuthError("Organization preferences are not available.", "usage");
  if (how.org !== undefined && !how.org.trim())
    throw new AuthError("Give --org an organization name, UUID or none.", "usage");

  const explicitOrigin = how.url ?? io.env.ARMADA_URL;
  const savedOrigin =
    how.org !== undefined && explicitOrigin === undefined ? (await io.session.read())?.armadaUrl : undefined;
  const origin = armadaApiUrl(explicitOrigin ?? savedOrigin);
  const client = authClient(origin, io.fetch);
  const timeout = io.timeoutMs ?? 35_000;
  const { authDeviceStart, authDevicePoll } = publicAuthOperations;
  const machine =
    hostname()
      .replace(/[^a-zA-Z0-9_.-]/g, "_")
      .slice(0, 253) || "unknown";
  const start = authDeviceStart.output.safeParse(loginPayload(await client.startDevice(machine, timeout)));
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
    const poll = authDevicePoll.output.safeParse(loginPayload(await client.pollDevice(device_code, timeout)));
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
        let org: string | undefined;
        let saveOrg = how.org !== undefined;
        if (how.org !== undefined && how.org !== "none") {
          const listed = organizationOperations.listOrganizations.output.safeParse(
            loginPayload(await client.listOrganizations(accessToken, timeout)),
          );
          if (!listed.success) throw new AuthError("Armada returned an invalid organization list.", "unavailable");
          org = resolveOrgReference(listed.data.orgs, how.org).id;
        } else if (how.org === undefined && preferences) {
          try {
            const listed = organizationOperations.listOrganizations.output.safeParse(
              loginPayload(await client.listOrganizations(accessToken, timeout)),
            );
            if (listed.success && listed.data.orgs.length === 1 && listed.data.orgs[0]) {
              org = listed.data.orgs[0].id;
              saveOrg = true;
            }
          } catch {}
        }
        const session = {
          loginId: crypto.randomUUID(),
          armadaUrl: origin,
          accessToken,
          refreshToken,
          expiresAt,
        } satisfies Session;
        if (saveOrg && preferences) {
          if (how.org !== undefined) await saveLoginSelection(io.session, session, preferences, org);
          else {
            await io.session.write(session);
            await preferences.write(origin, org).catch(() => {});
          }
        } else {
          await io.session.write(session);
        }
        const account = email.replace(/[\p{Cc}\p{Cf}]/gu, "");
        io.out(how.json ? '{"authenticated":true}\n' : `Signed in as ${account}.\n`);
        return;
      }
    }
  }
  throw new AuthError("This CLI login expired. Run armada login again.", "unauthorized");
}

async function saveLoginSelection(
  store: SessionStore,
  session: Session & { armadaUrl: string },
  preferences: Preferences,
  org: string | undefined,
) {
  const origin = session.armadaUrl;
  async function save(unlocked: SessionStore) {
    const previous = await preferences.read(origin);
    await preferences.write(origin, org);
    try {
      await unlocked.write(session);
    } catch (error) {
      try {
        await preferences.write(origin, previous);
      } catch {
        throw new AuthError(
          "Sign-in could not be saved, and the organization selection could not be restored.",
          "unavailable",
        );
      }
      throw error;
    }
  }
  await (store.withLock ? store.withLock(save) : save(store));
}

export async function logoutCommand(io: AuthIo, json = false): Promise<void> {
  await io.session.clear();
  io.out(json ? '{"authenticated":false}\n' : "Logged out.\n");
}

function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

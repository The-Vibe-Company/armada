// `armada login`, `armada whoami` and `armada logout`: who this terminal is on
// Armada. A person signs in with a code confirmed in the browser; a headless
// coordinator with an organization API key (ARMADA_API_KEY, or stored by
// `armada login --api-key`). The session token or key lives in the
// credentials file (0600) and is never printed.
import {
  API_KEY_VARIABLE,
  type ArmadaIdentity,
  type ArmadaSignIn,
  apiBaseUrl,
  armadaApi,
  type CredentialSource,
  type Credentials,
  displayCode,
  LOGIN_NEXT,
  machinePaths,
  SESSION_TOKEN_VARIABLE,
  updateCredentialStore,
  waitForApproval,
} from "@armada/core";
import { loadCredentials } from "./auth.ts";
import { type Io, UsageError } from "./io.ts";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const apiOf = (io: Io, credentials: Credentials) =>
  armadaApi({ url: credentials.armadaApi.url, ...(io.fetch ? { fetch: io.fetch } : {}) });

const sleepOf = (io: Io) => io.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

/** The sign-in a command needs; refuses with `armada login` as the next step when there is none. */
export function requireSignIn(credentials: Credentials): ArmadaSignIn & { source: CredentialSource } {
  if (credentials.armadaSignIn) return credentials.armadaSignIn;
  throw new UsageError(
    `not signed in to Armada (${hostOf(credentials.armadaApi.url)}). A person signs in with \`armada login\`; a headless coordinator sets ${API_KEY_VARIABLE} to an organization API key`,
    LOGIN_NEXT,
  );
}

/** One line: the person or the key, and the organization. */
export function describeIdentity(identity: ArmadaIdentity): string {
  const org = identity.organization
    ? `${identity.organization.name}${identity.organization.role ? ` (${identity.organization.role})` : ""}`
    : "no organization yet";
  if (identity.via === "api-key") {
    const key = identity.apiKey?.name ?? identity.apiKey?.start ?? "an API key";
    return `the API key "${key}" of ${org}`;
  }
  const who = identity.user
    ? identity.user.name
      ? `${identity.user.name} <${identity.user.email}>`
      : identity.user.email
    : "?";
  return `${who}, ${org}`;
}

function paths(io: Io) {
  const p = machinePaths(io.env);
  if (p) return p;
  throw new UsageError(
    `neither HOME nor XDG_CONFIG_HOME is set, so this machine has no place to keep a sign-in. Set ${API_KEY_VARIABLE} in the environment instead.`,
  );
}

/** Reads an API key without it ever reaching argv or shell history: a hidden prompt, or standard input. */
async function readApiKey(io: Io): Promise<string | null> {
  if (io.interactive && io.prompt) return io.prompt("Armada API key (hidden): ", { hidden: true });
  if (io.readStdin) return io.readStdin();
  return null;
}

async function loginWithApiKey(io: Io, credentials: Credentials): Promise<number> {
  const p = paths(io);
  const answer = await readApiKey(io);
  if (answer === null) {
    io.stderr("Cancelled. Nothing was saved.\n");
    return 130;
  }
  const key = answer.trim();
  if (!key)
    throw new UsageError(
      'no API key given. Paste it at the prompt, or pipe it in: printf %s "$KEY" | armada login --api-key',
      "the Organization page of Armada, where an owner creates one",
    );
  // Checked before it is stored: a mistyped or revoked key is refused now, not at the next command.
  const identity = await apiOf(io, credentials).whoami({ kind: "api-key", key });
  await updateCredentialStore(p, { [API_KEY_VARIABLE]: key, [SESSION_TOKEN_VARIABLE]: null });
  io.stdout(
    `Signed in to ${hostOf(credentials.armadaApi.url)} as ${describeIdentity(identity)}.\nThe key is stored in ${p.credentials}.\n`,
  );
  return 0;
}

export async function login(io: Io, apiKey: boolean): Promise<number> {
  const { machine, credentials } = await loadCredentials(io);
  const host = hostOf(credentials.armadaApi.url);
  if (credentials.armadaSignIn?.source.kind === "env")
    io.stderr(`! ${API_KEY_VARIABLE} is set in the environment: it wins over what \`armada login\` stores.\n`);
  if (apiKey) return loginWithApiKey(io, credentials);

  const p = paths(io);
  const api = apiOf(io, credentials);
  const code = await api.startDeviceLogin();
  io.stderr(
    `First copy your one-time code: ${displayCode(code.userCode)}\nThen confirm it at ${code.verificationUriComplete}\n`,
  );
  if (io.interactive && io.openUrl?.(code.verificationUriComplete)) io.stderr("Opening it in your browser.\n");
  io.stderr(`Waiting for the confirmation (the code expires in ${Math.round(code.expiresInSeconds / 60)} minutes)…\n`);
  const token = await waitForApproval({ api, code, sleep: sleepOf(io), now: io.now ?? (() => new Date()) });
  const identity = await api.whoami({ kind: "session", token });

  const previous = machine.store?.values[SESSION_TOKEN_VARIABLE]?.trim();
  await updateCredentialStore(p, { [SESSION_TOKEN_VARIABLE]: token, [API_KEY_VARIABLE]: null });
  // The session this one replaces is revoked, not left behind on the server.
  if (previous && previous !== token) await api.signOut({ kind: "session", token: previous }).catch(() => {});
  io.stdout(`Signed in to ${host} as ${describeIdentity(identity)}.\n`);
  if (!identity.organization)
    io.stdout(
      `Next: accept an invitation, or create an organization, at ${new URL("welcome", apiBaseUrl(credentials.armadaApi.url))}\n`,
    );
  return 0;
}

export async function whoami(io: Io, json: boolean): Promise<number> {
  const { credentials } = await loadCredentials(io);
  const signIn = requireSignIn(credentials);
  const identity = await apiOf(io, credentials).whoami(signIn);
  if (json) {
    const out = { ...identity, api: credentials.armadaApi.url, source: signIn.source };
    io.stdout(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  io.stdout(`Signed in to ${hostOf(credentials.armadaApi.url)} as ${describeIdentity(identity)}.\n`);
  return 0;
}

export async function logout(io: Io): Promise<number> {
  const { machine, credentials } = await loadCredentials(io);
  const p = paths(io);
  const stored = [SESSION_TOKEN_VARIABLE, API_KEY_VARIABLE].filter((k) => machine.store?.assigned.includes(k));
  const session = machine.store?.values[SESSION_TOKEN_VARIABLE]?.trim();
  if (session) {
    // Revoked on the server first, so a copy of the file is useless too; offline, the local copy still goes.
    await apiOf(io, credentials)
      .signOut({ kind: "session", token: session })
      .catch((err: unknown) =>
        io.stderr(
          `! the session could not be revoked on Armada (${err instanceof Error ? err.message : String(err)}); it expires on its own\n`,
        ),
      );
  }
  if (stored.length) {
    await updateCredentialStore(p, { [SESSION_TOKEN_VARIABLE]: null, [API_KEY_VARIABLE]: null });
    io.stdout(`Signed out of ${hostOf(credentials.armadaApi.url)}: removed the sign-in from ${p.credentials}.\n`);
  } else io.stdout(`This terminal was not signed in to Armada (nothing in ${p.credentials}).\n`);
  if (io.env[API_KEY_VARIABLE]?.trim())
    io.stdout(
      `${API_KEY_VARIABLE} is still set in the environment, and still signs this terminal in. Unset it to stop.\n`,
    );
  return 0;
}

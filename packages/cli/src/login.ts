// `armada login`, `armada whoami` and `armada logout`: who this terminal is on
// Armada. A person signs in with a code confirmed in the browser; a headless
// coordinator with an organization API key (ARMADA_API_KEY, or stored by
// `armada login --api-key`); a worker with the one-time launch token of its
// launch message (`armada login --launch-token`), for a worker session on its
// ticket only. The session token or key lives in the credentials file (0600)
// and is never printed.
import {
  API_KEY_VARIABLE,
  type ArmadaIdentity,
  type ArmadaSignIn,
  apiBaseUrl,
  armadaAddress,
  type CredentialSource,
  type Credentials,
  DEFAULT_ARMADA_API_URL,
  displayCode,
  formatWorkerSession,
  isMaskedLaunchToken,
  LOGIN_NEXT,
  MASKED_LAUNCH_TOKEN_REFUSAL,
  machinePaths,
  RETIRED_VARIABLES,
  Refusal,
  SESSION_TOKEN_VARIABLE,
  SIGNED_IN_TO_VARIABLE,
  updateCredentialStore,
  WORKER_SESSION_PREFIX,
  waitForApproval,
  workerSessionVariable,
} from "@armada/core";
import { apiOf } from "./api.ts";
import { loadCredentials, type Machine } from "./auth.ts";
import { type Io, UsageError } from "./io.ts";

export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const RETIRED = Object.fromEntries(RETIRED_VARIABLES.map((v) => [v, null]));

/** The Armada the stored sign-in belongs to; its token is sent to no other. */
const storedAt = (machine: Machine) =>
  armadaAddress(machine.store?.values[SIGNED_IN_TO_VARIABLE]?.trim() || DEFAULT_ARMADA_API_URL);

const sleepOf = (io: Io) => io.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

/** The sign-in a command needs; refuses with `armada login` as the next step when there is none. */
export function requireSignIn(credentials: Credentials): ArmadaSignIn & { source: CredentialSource } {
  if (credentials.armadaSignIn) return credentials.armadaSignIn;
  const elsewhere = credentials.armadaSignInElsewhere;
  if (elsewhere)
    throw new UsageError(
      `this terminal is signed in to ${hostOf(elsewhere)}, not to ${hostOf(credentials.armadaApi.url)} (named by ARMADA_API_URL or [api] url); its sign-in is never sent to another Armada`,
      `armada login to sign in to ${hostOf(credentials.armadaApi.url)}, or point ARMADA_API_URL back to ${elsewhere}`,
    );
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
  if (identity.via === "worker") {
    const w = identity.worker;
    return w
      ? `the worker of ${w.ticket} (${w.project}), launched by ${w.launchedBy}, in ${org}`
      : `a worker of ${org}`;
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
  const url = credentials.armadaApi.url;
  const identity = await apiOf(io, url).whoami({ kind: "api-key", key });
  await updateCredentialStore(p, {
    [API_KEY_VARIABLE]: key,
    [SESSION_TOKEN_VARIABLE]: null,
    [SIGNED_IN_TO_VARIABLE]: armadaAddress(url),
    // Keys of earlier versions are never read again: none stays on the machine.
    ...RETIRED,
  });
  io.stdout(
    `Signed in to ${hostOf(credentials.armadaApi.url)} as ${describeIdentity(identity)}.\nThe key is stored in ${p.credentials}.\n`,
  );
  return 0;
}

/** The worker's runtime session when its environment names one (Conductor's), sent with its launch token. */
export function sessionHandle(io: Io): string | null {
  const workspace = io.env.CONDUCTOR_WORKSPACE_ID?.trim();
  const session = io.env.CONDUCTOR_SESSION_ID?.trim();
  return workspace && session ? `${workspace}/${session}` : null;
}

/**
 * Exchanges the launch message's token for a worker session and keeps it under
 * its ticket's key, beside any other sign-in: a person's session on the same
 * machine stays, and several workers can share it.
 */
async function loginWithLaunchToken(
  io: Io,
  credentials: Credentials,
  token: string,
  apiUrl: string | null,
): Promise<number> {
  // The brief's human view hides the token: it was copied from there, not from `--prompt`.
  if (isMaskedLaunchToken(token))
    throw new Refusal(MASKED_LAUNCH_TOKEN_REFUSAL.error, MASKED_LAUNCH_TOKEN_REFUSAL.next);
  const p = paths(io);
  let url = credentials.armadaApi.url;
  if (apiUrl) {
    apiBaseUrl(apiUrl);
    if (credentials.armadaApi.source.kind !== "default" && armadaAddress(apiUrl) !== armadaAddress(url))
      throw new UsageError(
        `the launch message names ${hostOf(apiUrl)}, but ARMADA_API_URL or [api] url names ${hostOf(url)}`,
        "unset ARMADA_API_URL, or ask the coordinator for a launch from that Armada",
      );
    url = apiUrl;
  }
  const session = await apiOf(io, url).exchangeLaunchToken(token.trim(), sessionHandle(io));
  const w = session.worker;
  await updateCredentialStore(p, {
    [workerSessionVariable(w.ticket)]: formatWorkerSession({
      api: armadaAddress(url),
      token: session.token,
      ticket: w.ticket,
      project: w.project,
      organization: session.organization.id,
      id: w.id,
    }),
  });
  io.stdout(
    `Signed in to ${hostOf(url)} as the worker of ${w.ticket} (${w.project}) in ${session.organization.name}, launched by ${w.launchedBy}.\nThis terminal claims, reports, asks and releases ${w.ticket} only; Armada gives each of those commands its keys.\n`,
  );
  return 0;
}

export interface LoginOptions {
  apiKey: boolean;
  launchToken: string | null;
  apiUrl: string | null;
}

export async function login(io: Io, o: LoginOptions): Promise<number> {
  if (o.apiUrl !== null && o.launchToken === null)
    throw new UsageError("--api-url goes with --launch-token: it names the Armada of the launch message");
  if (o.launchToken !== null && o.apiKey) throw new UsageError("pass --api-key or --launch-token, not both");
  const { machine, credentials } = await loadCredentials(io, { armada: false });
  if (o.launchToken !== null) {
    if (!o.launchToken.trim()) throw new UsageError("--launch-token needs the token of the launch message");
    return loginWithLaunchToken(io, credentials, o.launchToken, o.apiUrl);
  }
  const host = hostOf(credentials.armadaApi.url);
  if (credentials.armadaSignIn?.source.kind === "env")
    io.stderr(`! ${API_KEY_VARIABLE} is set in the environment: it wins over what \`armada login\` stores.\n`);
  if (o.apiKey) return loginWithApiKey(io, credentials);

  const p = paths(io);
  const url = credentials.armadaApi.url;
  const api = apiOf(io, url);
  const code = await api.startDeviceLogin();
  io.stderr(
    `First copy your one-time code: ${displayCode(code.userCode)}\nThen confirm it at ${code.verificationUriComplete}\n`,
  );
  if (io.interactive && io.openUrl?.(code.verificationUriComplete)) io.stderr("Opening it in your browser.\n");
  io.stderr(`Waiting for the confirmation (the code expires in ${Math.round(code.expiresInSeconds / 60)} minutes)…\n`);
  const token = await waitForApproval({ api, code, sleep: sleepOf(io), now: io.now ?? (() => new Date()) });
  const identity = await api.whoami({ kind: "session", token });

  const previous = machine.store?.values[SESSION_TOKEN_VARIABLE]?.trim();
  await updateCredentialStore(p, {
    [SESSION_TOKEN_VARIABLE]: token,
    [API_KEY_VARIABLE]: null,
    [SIGNED_IN_TO_VARIABLE]: armadaAddress(url),
    // Keys of earlier versions are never read again: none stays on the machine.
    ...RETIRED,
  });
  // The session this one replaces is revoked on the Armada that issued it, not left behind.
  if (previous && previous !== token)
    await apiOf(io, storedAt(machine))
      .signOut({ kind: "session", token: previous })
      .catch(() => {});
  io.stdout(`Signed in to ${host} as ${describeIdentity(identity)}.\n`);
  if (!identity.organization)
    io.stdout(
      `Next: accept an invitation, or create an organization, at ${new URL("welcome", apiBaseUrl(credentials.armadaApi.url))}\n`,
    );
  return 0;
}

export async function whoami(io: Io, json: boolean): Promise<number> {
  let { credentials } = await loadCredentials(io, { armada: false });
  // A worker's machine holds only its worker session: that is who it is.
  const [only] = credentials.workerTickets;
  if (!credentials.armadaSignIn && only && credentials.workerTickets.length === 1)
    ({ credentials } = await loadCredentials(io, {
      armada: false,
      worker: { command: "whoami", project: "", ticket: () => only },
    }));
  const signIn = requireSignIn(credentials);
  const identity = await apiOf(io, credentials.armadaApi.url).whoami(signIn);
  if (json) {
    const out = { ...identity, api: credentials.armadaApi.url, source: signIn.source };
    io.stdout(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  io.stdout(`Signed in to ${hostOf(credentials.armadaApi.url)} as ${describeIdentity(identity)}.\n`);
  return 0;
}

export async function logout(io: Io): Promise<number> {
  const { machine } = await loadCredentials(io, { armada: false });
  const p = paths(io);
  const at = storedAt(machine);
  const workers = (machine.store?.assigned ?? []).filter((k) => k.startsWith(WORKER_SESSION_PREFIX));
  const stored = [SESSION_TOKEN_VARIABLE, API_KEY_VARIABLE, ...RETIRED_VARIABLES, ...workers].filter((k) =>
    machine.store?.assigned.includes(k),
  );
  const session = machine.store?.values[SESSION_TOKEN_VARIABLE]?.trim();
  if (session) {
    // Revoked on the server first, so a copy of the file is useless too; offline, the local copy still goes.
    await apiOf(io, at)
      .signOut({ kind: "session", token: session })
      .catch((err: unknown) =>
        io.stderr(
          `! the session could not be revoked on Armada (${err instanceof Error ? err.message : String(err)}); it expires on its own\n`,
        ),
      );
  }
  if (stored.length) {
    await updateCredentialStore(p, {
      [SESSION_TOKEN_VARIABLE]: null,
      [API_KEY_VARIABLE]: null,
      [SIGNED_IN_TO_VARIABLE]: null,
      ...RETIRED,
      // Worker sessions are forgotten, not ended: `armada release` ends one.
      ...Object.fromEntries(workers.map((k) => [k, null])),
    });
    io.stdout(`Signed out of ${hostOf(at)}: removed the sign-in from ${p.credentials}.\n`);
  } else io.stdout(`This terminal was not signed in to Armada (nothing in ${p.credentials}).\n`);
  if (io.env[API_KEY_VARIABLE]?.trim())
    io.stdout(
      `${API_KEY_VARIABLE} is still set in the environment, and still signs this terminal in. Unset it to stop.\n`,
    );
  return 0;
}

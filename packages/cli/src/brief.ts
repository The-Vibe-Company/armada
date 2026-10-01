// `armada brief <ticket>`: the launch prompt and settings for a new worker.
// Prints variable names and whether this shell has them, never their values.
// Signed in to Armada, it asks for a one-time launch token for the ticket and
// puts it in the prompt: the worker's runtime then needs no key.

import { dirname, join } from "node:path";
import {
  ArmadaApiError,
  type ArmadaConfig,
  armadaAddress,
  armadaApi,
  type Brief,
  BriefError,
  type BriefLaunch,
  type Credentials,
  checkRequestedProfile,
  DEFAULT_ARMADA_API_URL,
  LINEAR_KEY,
  loadBrief,
  ProfileError,
  STORED_KEYS,
} from "@armada/core";
import { type Io, missingKey, UsageError } from "./io.ts";
import { rearmFor, remember, watchOf } from "./watch.ts";

export interface BriefArgs {
  rest: string[];
  options: Record<string, string>;
  json: boolean;
}

export function renderBrief(b: Brief): string {
  const p = b.profile;
  const width = Math.max(...b.environment.map((v) => v.name.length + (v.value ? v.value.length + 1 : 0)));
  const out = [
    `Brief for ${b.ticket.id} — ${b.ticket.title} (${b.ticket.status})`,
    b.ticket.url,
    "",
    `Runtime:     conductor (follow the armada-runtime-conductor skill to launch)`,
    `Profile:     ${p ? `${p.name}: agent ${p.agent}, model ${p.model}, effort ${p.effort}${p.fastMode ? ", fast mode" : ""}` : "none declared in armada.toml"}`,
    ...(b.routing ? [`Chosen by:   ${b.routing.why}`] : []),
    `Plans:       ${b.plans.rule === "pre-approved" ? "pre-approved" : "wait for approval"} (${b.plans.why})`,
    ...(b.conventions ? [`Conventions: ${b.conventions.path} (under "Project conventions" in the prompt)`] : []),
    `Repository:  ${b.repository.url}`,
    `Branch:      ${b.ticket.branch ?? "none suggested by Linear"} (the worker renames its workspace branch to it)`,
    `Launch:      ${b.launch ? `one-time token in the prompt, valid until ${b.launch.expiresAt.slice(0, 16).replace("T", " ")} UTC: the worker needs no key` : `no launch token${b.noLaunch ? ` (${b.noLaunch})` : ""}: pass the keys below in the worker's environment`}`,
    "",
    "Environment to pass (values are never printed):",
    ...b.environment.map((v) => {
      const label = v.value ? `${v.name}=${v.value}` : v.name;
      const state = v.value
        ? "value above"
        : v.inShell
          ? "set in this shell"
          : v.inStore
            ? "in credentials file"
            : "NOT set in this shell";
      return `  ${label.padEnd(width)}  ${v.required ? "required" : "optional"}  ${state.padEnd(21)}  ${v.purpose}`;
    }),
  ];
  if (b.warnings.length) out.push("", "Warnings:", ...b.warnings.map((w) => `  - ${w}`));
  out.push("", `----- prompt (\`armada brief ${b.ticket.id} --prompt\` prints only this) -----`, "", b.prompt);
  return out.join("\n");
}

/**
 * Asks Armada for the worker's launch token, as the signed-in coordinator. Not
 * signed in, or refused (no accounts, no vault), the brief goes on without one.
 */
function launcher(io: Io, config: ArmadaConfig, credentials: Credentials) {
  return async (ticket: string): Promise<BriefLaunch | { reason: string; warn: boolean }> => {
    const signIn = credentials.armadaSignIn;
    if (!signIn)
      return {
        reason: "launch tokens need this terminal signed in to an Armada with accounts: armada login",
        warn: false,
      };
    const url = credentials.armadaApi.url;
    try {
      const t = await armadaApi({ url, ...(io.fetch ? { fetch: io.fetch } : {}) }).launchToken(signIn, {
        project: config.project.slug,
        ticket,
      });
      const builtIn = armadaAddress(url) === armadaAddress(DEFAULT_ARMADA_API_URL);
      return { token: t.token, expiresAt: t.expiresAt, apiUrl: builtIn ? null : armadaAddress(url) };
    } catch (err) {
      if (!(err instanceof ArmadaApiError)) throw err;
      return { reason: err.message, warn: true };
    }
  };
}

export async function brief(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  a: BriefArgs,
  version: string,
  configPath: string,
) {
  const [ticket, ...extra] = a.rest;
  if (!ticket)
    throw new UsageError('brief needs a ticket: armada brief <ticket> [--profile <name> [--reason "<why>"]]');
  if (extra.length) throw new UsageError(`unexpected argument ${extra[0]}`);
  const promptOnly = a.options.prompt === "true";
  if (a.json && promptOnly) throw new UsageError("pass --json or --prompt, not both");
  const profile = a.options.profile?.trim() || null;
  const reason = a.options.reason?.trim() || null;
  if (reason && !profile)
    throw new UsageError("--reason goes with --profile: it says why the routed profile is not used");
  try {
    checkRequestedProfile(config, profile);
  } catch (err) {
    if (err instanceof ProfileError) throw new UsageError(err.message);
    throw err;
  }
  if (!credentials.linearApiKey) throw missingKey(LINEAR_KEY);
  // `[brief] extra` is a path of the repository, relative to armada.toml.
  const extraPath = config.brief.extra;
  const conventions = extraPath
    ? { path: extraPath, text: await io.readFile(join(dirname(configPath), extraPath)).catch(() => null) }
    : null;
  let b: Brief;
  try {
    b = await loadBrief(config, {
      linearApiKey: credentials.linearApiKey,
      ticket: ticket.toUpperCase(),
      profile,
      reason,
      version,
      env: io.env,
      stored: STORED_KEYS.filter((k) => credentials.sources[k.name]?.kind === "store").map((k) => k.variable),
      launch: launcher(io, config, credentials),
      conventions,
      ...(io.fetch ? { fetch: io.fetch } : {}),
      ...(io.now ? { now: io.now } : {}),
    });
  } catch (err) {
    if (err instanceof BriefError) throw new UsageError(err.message);
    throw err;
  }
  // Once this worker is launched, it is in flight with the ones known before: the stop hook counts it at once.
  const project = config.project.slug;
  const known = (await watchOf(io, project)).state?.inFlight ?? [];
  const inFlight = [...new Set([...known, b.ticket.id])].sort((x, y) => x.localeCompare(y, "en", { numeric: true }));
  await remember(io, project, { inFlight, readAt: (io.now ?? (() => new Date()))().toISOString() });
  if (promptOnly) {
    // The worker's prompt, as is: the re-arm line is for the coordinator.
    io.stdout(b.prompt);
    for (const w of b.warnings) io.stderr(`armada: warning: ${w}\n`);
    return 0;
  }
  const next = await rearmFor(io, project, { inFlight, open: null });
  if (a.json) io.stdout(`${JSON.stringify({ ...b, watch: next }, null, 2)}\n`);
  else io.stdout(`${renderBrief(b)}\n\n----- once launched -----\n${next.line}\n`);
  return 0;
}

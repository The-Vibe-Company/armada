import { liveFleet } from "./worker.ts";
// `armada brief <ticket>`: the launch prompt and settings for a new worker.
// Prints variable names and whether this shell has them, never their values.
// Signed in to Armada, it asks for a one-time launch token for the ticket and
// puts it in the prompt: the worker's runtime then needs no key. Only
// `--prompt` prints that token; elsewhere it is hidden, so it never lands in
// the coordinator's transcript.

import { dirname, join } from "node:path";
import {
  ArmadaApiError,
  type ArmadaConfig,
  armadaAddress,
  type Brief,
  BriefError,
  type BriefLaunch,
  type Credentials,
  checkPublished,
  checkRequestedProfile,
  DEFAULT_ARMADA_API_URL,
  LINEAR_KEY,
  loadBrief,
  MASKED_LAUNCH_TOKEN,
  ProfileError,
  type ProfileSelectionBrief,
  STORED_KEYS,
  shellWord,
} from "@armada/core";
import { apiOf } from "./api.ts";
import { httpOptions, type Io, missingKey, UsageError } from "./io.ts";
import { rearmFor, remember, watchOf } from "./watch.ts";
import { liveFleet } from "./worker.ts";

export interface BriefArgs {
  rest: string[];
  options: Record<string, string>;
  json: boolean;
}

/** How a launch token shows outside `--prompt`. */
export const HIDDEN_LAUNCH_TOKEN = MASKED_LAUNCH_TOKEN;

/**
 * The brief with its launch token hidden, for the human view and --json: the
 * word after --launch-token, and anything else shaped like a launch token.
 */
export function hideLaunchToken(b: Brief): Brief {
  if (!b.launch) return b;
  const token = b.launch.command.match(/--launch-token[ =](\S+)/)?.[1];
  const hide = (text: string) =>
    (token ? text.replaceAll(token, HIDDEN_LAUNCH_TOKEN) : text).replace(
      /armada_launch_[^\s'"`•]+/g,
      HIDDEN_LAUNCH_TOKEN,
    );
  return { ...b, prompt: hide(b.prompt), launch: { ...b.launch, command: hide(b.launch.command) } };
}

export function renderBrief(b: Brief): string {
  const p = b.profile;
  const v = b.validation;
  const validationFlags = v
    ? v.rules.length
      ? ` --validation ${v.rules.map((r) => r.index).join(",")}${v.reason ? ` --validation-reason ${shellWord(v.reason)}` : ""}`
      : " --validation none"
    : "";
  const promptCommand = `armada brief ${b.ticket.id}${p && (b.routing?.source === "requested" || b.routing?.reason) ? ` --profile ${shellWord(p.name)}${b.routing?.reason ? ` --reason ${shellWord(b.routing.reason)}` : ""}` : ""}${validationFlags} --prompt`;
  const width = Math.max(...b.environment.map((v) => v.name.length + (v.value ? v.value.length + 1 : 0)));
  const out = [
    `Brief for ${b.ticket.id} — ${b.ticket.title} (${b.ticket.status})`,
    b.ticket.url,
    "",
    `Runtime:     ${b.runtime} (follow the armada-runtime-${b.runtime} skill to launch)`,
    `Profile:     ${p ? `${p.name}: agent ${p.agent}, model ${p.model}, effort ${p.effort}${b.runtime === "claude-code" ? " (not applied by the Agent tool)" : ""}${p.fastMode ? ", fast mode" : ""}` : "none declared in armada.toml"}`,
    ...(b.routing ? [`Chosen by:   ${b.routing.why}`] : []),
    `Plans:       ${b.plans.rule === "pre-approved" ? "pre-approved" : "wait for approval"} (${b.plans.why})`,
    ...(v
      ? [
          `Validation:  ${v.rules.length ? `the owner validates: ${v.rules.map((r) => `rule ${r.index} (${r.when})`).join(", ")}${v.reason ? ` — ${v.reason}` : ""}` : "no [[policy.validation]] rule applies"}`,
        ]
      : []),
    ...(b.conventions ? [`Conventions: ${b.conventions.path} (under "Project conventions" in the prompt)`] : []),
    `Repository:  ${b.repository.url}`,
    `Branch:      ${b.ticket.branch ?? "none suggested by Linear"} (the worker renames its workspace branch to it)`,
    `Launch:      ${b.launchHint ?? (b.launch ? `one-time token in the prompt, valid until ${b.launch.expiresAt.slice(0, 16).replace("T", " ")} UTC: the worker needs no key\n             (shown as ${HIDDEN_LAUNCH_TOKEN} here; \`${promptCommand}\` prints it)` : `no launch token${b.noLaunch ? ` (${b.noLaunch})` : ""}: pass the keys below in the worker's environment`)}`,
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
  out.push("", `----- prompt (\`${promptCommand}\` prints only this) -----`, "", b.prompt);
  return out.join("\n");
}

export function renderProfileSelection(b: ProfileSelectionBrief): string {
  return [
    `Choose a profile for ${b.ticket.id} — ${b.ticket.title}`,
    b.ticket.url,
    "",
    "In short:",
    b.ticket.inShort || "No In short section on this ticket; read the full ticket before choosing.",
    "",
    ...(b.parent ? [`Parent: ${b.parent.id} — ${b.parent.title} (${b.parent.url}). Read it before choosing.`, ""] : []),
    ...b.selection.profiles.map(
      (profile) => `  ${profile.name}: ${profile.when ?? "no when rule; choose only with a reason"}`,
    ),
    "",
    b.selection.hint,
    ...(b.launchHint ? [`Launch: ${b.launchHint}`] : []),
    ...b.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");
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
      const t = await apiOf(io, url).launchToken(signIn, {
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

/** The coordinator's brief command as typed, without its validation flags: what a refusal completes for them to copy. */
function briefCommand(ticket: string, a: BriefArgs): string {
  const o = a.options;
  return [
    `armada brief ${ticket}`,
    o.profile ? ` --profile ${shellWord(o.profile)}` : "",
    o.reason ? ` --reason ${shellWord(o.reason)}` : "",
    o.prompt === "true" ? " --prompt" : "",
    o["profile-line"] === "true" ? " --profile-line" : "",
    a.json ? " --json" : "",
  ].join("");
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
  if (a.options["profile-line"] && !promptOnly) throw new UsageError("--profile-line goes with --prompt");
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
  const { fleet } = liveFleet(io, config, credentials);
  let b: Brief | ProfileSelectionBrief;
  try {
    b = await loadBrief(config, {
      linearApiKey: credentials.linearApiKey,
      ticket: ticket.toUpperCase(),
      profile,
      reason,
      version,
      env: io.env,
      stored: STORED_KEYS.filter((k) => credentials.sources[k.name]?.kind === "store").map((k) => k.variable),
      prompt: promptOnly,
      launch: launcher(io, config, credentials),
      overlap: liveFleet(io, config, credentials).fleet?.overlap,
      // A worker cannot install a version npm does not serve yet.
      npm: (v) => checkPublished(v, io.fetch ?? fetch),
      conventions,
      ...(fleet ? { reservations: () => fleet.reservations() } : {}),
      validation: {
        requested: a.options.validation ?? null,
        reason: a.options["validation-reason"] ?? null,
        command: briefCommand(ticket.toUpperCase(), a),
      },
      ...httpOptions(io),
      ...(io.now ? { now: io.now } : {}),
    });
  } catch (err) {
    if (err instanceof BriefError) throw new UsageError(err.message, err.next ?? undefined);
    throw err;
  }
  if ("selection" in b) {
    if (promptOnly) throw new UsageError(b.selection.hint);
    io.stdout(`${a.json ? JSON.stringify(b, null, 2) : renderProfileSelection(b)}\n`);
    return 0;
  }
  // Once this worker is launched, it is in flight with the ones known before: the stop hook counts it at once.
  const project = config.project.slug;
  const known = (await watchOf(io, project)).state?.inFlight ?? [];
  if (promptOnly) {
    const inFlight = [...new Set([...known, b.ticket.id])].sort((x, y) => x.localeCompare(y, "en", { numeric: true }));
    await remember(io, project, { inFlight, readAt: (io.now ?? (() => new Date()))().toISOString() });
    if (a.options["profile-line"]) {
      const profile = b.profile;
      io.stderr(
        `Profile: ${profile ? `${profile.name}: agent ${profile.agent}, model ${profile.model}, effort ${profile.effort}${profile.fastMode ? ", fast mode" : ""}` : "none declared in armada.toml"}, runtime ${b.runtime}${b.routing ? ` — ${b.routing.why}` : ""}\n`,
      );
      io.stderr(
        `Launch: ${b.launch ? `one-time token made, valid until ${b.launch.expiresAt}` : `no launch token${b.noLaunch ? ` (${b.noLaunch})` : ""}`}\n`,
      );
    }
    // The worker's prompt, as is: the re-arm line is for the coordinator.
    io.stdout(b.prompt);
    for (const w of b.warnings) io.stderr(`armada: warning: ${w}\n`);
    return 0;
  }
  const next = await rearmFor(io, project, { inFlight: known, open: null });
  const shown = hideLaunchToken(b);
  if (a.json) io.stdout(`${JSON.stringify({ ...shown, watch: next }, null, 2)}\n`);
  else io.stdout(`${renderBrief(shown)}\n\n----- once launched -----\n${next.line}\n`);
  return 0;
}

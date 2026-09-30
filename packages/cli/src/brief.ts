// `armada brief <ticket>`: the launch prompt and settings for a new worker.
// Prints variable names and whether this shell has them, never their values.
import {
  type ArmadaConfig,
  type Brief,
  BriefError,
  type Credentials,
  LINEAR_KEY,
  loadBrief,
  missingKeyMessage,
} from "@armada/core";
import { type Io, UsageError } from "./io.ts";

export interface BriefArgs {
  rest: string[];
  options: Record<string, string>;
  json: boolean;
  prompt: boolean;
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
    `Repository:  ${b.repository.url}`,
    `Branch:      ${b.ticket.branch ?? "none suggested by Linear"} (the worker renames its workspace branch to it)`,
    "",
    "Environment to pass (values are never printed):",
    ...b.environment.map((v) => {
      const label = v.value ? `${v.name}=${v.value}` : v.name;
      const state = v.value ? "value above" : v.inShell ? "set in this shell" : "NOT set in this shell";
      return `  ${label.padEnd(width)}  ${v.required ? "required" : "optional"}  ${state.padEnd(21)}  ${v.purpose}`;
    }),
  ];
  if (b.warnings.length) out.push("", "Warnings:", ...b.warnings.map((w) => `  - ${w}`));
  out.push("", `----- prompt (\`armada brief ${b.ticket.id} --prompt\` prints only this) -----`, "", b.prompt);
  return out.join("\n");
}

export async function brief(io: Io, config: ArmadaConfig, credentials: Credentials, a: BriefArgs, version: string) {
  const [ticket, ...extra] = a.rest;
  if (!ticket) throw new UsageError("brief needs a ticket: armada brief <ticket> [--profile <name>]");
  if (extra.length) throw new UsageError(`unexpected argument ${extra[0]}`);
  if (a.json && a.prompt) throw new UsageError("pass --json or --prompt, not both");
  if (!credentials.linearApiKey) throw new UsageError(missingKeyMessage(LINEAR_KEY));
  let b: Brief;
  try {
    b = await loadBrief(config, {
      linearApiKey: credentials.linearApiKey,
      ticket: ticket.toUpperCase(),
      profile: a.options.profile?.trim() || null,
      version,
      env: io.env,
      ...(io.fetch ? { fetch: io.fetch } : {}),
      ...(io.now ? { now: io.now } : {}),
    });
  } catch (err) {
    if (err instanceof BriefError) throw new UsageError(err.message);
    throw err;
  }
  if (a.json) io.stdout(`${JSON.stringify(b, null, 2)}\n`);
  else if (a.prompt) {
    io.stdout(b.prompt);
    for (const w of b.warnings) io.stderr(`armada: warning: ${w}\n`);
  } else io.stdout(renderBrief(b));
  return 0;
}

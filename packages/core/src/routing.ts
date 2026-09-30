// Which Conductor profile a worker runs on. The ticket's Linear labels route
// it (`[[conductor.routing]]`, first match in file order), `default_profile`
// catches the rest, and the coordinator may override the route with `--profile`
// only when it says why. Pure: the caller brings the ticket's labels.
import type { ArmadaConfig, ConductorProfile } from "./config.ts";
import { sameName } from "./linear.ts";

/** The rule that routed a ticket. */
export interface MatchedRule {
  /** Position of the rule among the `[[conductor.routing]]` tables, from 1. */
  index: number;
  labels: string[];
  /** The ticket's label that matched, as Linear names it. */
  label: string;
}

/** What routing alone recommends for a ticket. */
export interface Route {
  name: string;
  /** `rule`: a routing rule matched; `default`: `default_profile`; `only`: the one profile declared. */
  source: "rule" | "default" | "only";
  rule: MatchedRule | null;
}

export interface ProfileChoice {
  name: string;
  profile: ConductorProfile;
  /** `requested`: `--profile` overrode the route (or there was none); otherwise how the route was found. */
  source: "requested" | Route["source"];
  rule: MatchedRule | null;
  /** The profile routing recommends; differs from `name` when the coordinator overrode it. */
  routed: string | null;
  /** Why the coordinator overrode the route; required then. */
  reason: string | null;
  /** One line saying why this profile, for people. */
  why: string;
}

/** A profile that does not exist, cannot be chosen, or an override without a reason. */
export class ProfileError extends Error {
  override name = "ProfileError";
}

/** The profile a ticket with these labels is routed to: first matching rule, else the default, else the only profile. */
export function routeProfile(config: ArmadaConfig, labels: string[]): Route | null {
  const { routing, defaultProfile, profiles } = config.conductor;
  for (const [i, rule] of routing.entries()) {
    const label = labels.find((l) => rule.labels.some((r) => sameName(r, l)));
    if (label !== undefined)
      return { name: rule.profile, source: "rule", rule: { index: i + 1, labels: rule.labels, label } };
  }
  if (defaultProfile) return { name: defaultProfile, source: "default", rule: null };
  const names = Object.keys(profiles);
  return names.length === 1 && names[0] ? { name: names[0], source: "only", rule: null } : null;
}

export function describeRoute(route: Route, config: ArmadaConfig): string {
  if (route.rule) return `rule ${route.rule.index} of [[conductor.routing]] (label "${route.rule.label}")`;
  if (route.source === "default")
    return config.conductor.routing.length
      ? "conductor.default_profile (no routing rule matched)"
      : "conductor.default_profile";
  return "the only profile in armada.toml";
}

/** Throws ProfileError when `requested` names no profile. Needs no ticket, so it runs before any network call. */
export function checkRequestedProfile(config: ArmadaConfig, requested: string | null): void {
  if (requested === null || Object.hasOwn(config.conductor.profiles, requested)) return;
  const names = Object.keys(config.conductor.profiles);
  throw new ProfileError(`no Conductor profile "${requested}" (available: ${names.join(", ") || "none"})`);
}

/**
 * The profile to launch or record: `requested` (`--profile`), else the route.
 * An override of the route needs a reason. Null when armada.toml declares no
 * profile and none was requested.
 */
export function chooseProfile(
  config: ArmadaConfig,
  input: { ticket: string; labels: string[]; requested: string | null; reason: string | null },
): ProfileChoice | null {
  checkRequestedProfile(config, input.requested);
  const { profiles } = config.conductor;
  // One line: it is recorded in the claim comment.
  const reason = input.reason?.replace(/\s+/g, " ").trim() || null;
  const route = routeProfile(config, input.labels);
  if (input.requested === null) {
    if (route && Object.hasOwn(profiles, route.name))
      return {
        name: route.name,
        profile: profiles[route.name] as ConductorProfile,
        source: route.source,
        rule: route.rule,
        routed: route.name,
        reason,
        why: describeRoute(route, config),
      };
    const names = Object.keys(profiles);
    if (!names.length) return null;
    throw new ProfileError(
      `several Conductor profiles and no conductor.default_profile; pass --profile (${names.join(", ")})`,
    );
  }
  const name = input.requested;
  const profile = profiles[name] as ConductorProfile;
  if (route?.name === name)
    return {
      name,
      profile,
      source: route.source,
      rule: route.rule,
      routed: name,
      reason,
      why: describeRoute(route, config),
    };
  if (route && !reason)
    throw new ProfileError(
      `${input.ticket} is routed to "${route.name}" by ${describeRoute(route, config)}; say why "${name}" instead with --reason "<why>"`,
    );
  const why = route
    ? `--profile, instead of "${route.name}" from ${describeRoute(route, config)}: ${reason}`
    : `--profile${reason ? `: ${reason}` : ""}`;
  return { name, profile, source: "requested", rule: null, routed: route?.name ?? null, reason, why };
}

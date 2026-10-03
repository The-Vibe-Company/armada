// Which Conductor profile a worker runs on. The ticket's Linear labels route
// it (`[[conductor.routing]]`, first match in file order); plain-language `when`
// rules ask the coordinator instead of using a default. It may override a route with `--profile`
// only when it says why. Pure: the caller brings the ticket's labels.
import { type ArmadaConfig, type ConductorProfile, type HerdrProfile, routingLabelKey } from "./config.ts";

/** The profile section used for a launch. Conductor remains the default for older callers. */
export type ProfileSelectionRuntime = "conductor" | "herdr";

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

interface ProfileChoiceBase<P> {
  name: string;
  profile: P;
  /** `requested`: `--profile` overrode the route (or there was none); otherwise how the route was found. */
  source: "requested" | Route["source"];
  rule: MatchedRule | null;
  /** The profile routing recommends; differs from `name` when the coordinator overrode it. */
  routed: string | null;
  /** Why the coordinator chose or overrode the profile; required for semantic choices and routing overrides. */
  reason: string | null;
  /** One line saying why this profile, for people. */
  why: string;
}

export interface ProfileChoice extends ProfileChoiceBase<ConductorProfile> {}

export interface HerdrProfileChoice extends ProfileChoiceBase<HerdrProfile> {}

/** A profile that does not exist, cannot be chosen, or an override without a reason. */
export class ProfileError extends Error {
  override name = "ProfileError";
}

const profileSection = (config: ArmadaConfig, runtime: ProfileSelectionRuntime) =>
  runtime === "herdr" ? config.herdr : config.conductor;

const runtimeName = (runtime: ProfileSelectionRuntime): "Conductor" | "Herdr" =>
  runtime === "herdr" ? "Herdr" : "Conductor";

export const hasProfileRules = (config: ArmadaConfig, runtime: ProfileSelectionRuntime = "conductor"): boolean =>
  Object.values(profileSection(config, runtime).profiles).some((profile) => !!profile.when);

export const profileChoiceHint = (ticket: string, runtime: ProfileSelectionRuntime = "conductor"): string =>
  `Choose ${runtime === "herdr" ? "a Herdr profile" : "a profile"}: read the ticket and its parent, match the profiles' when rules, then run armada ${runtime === "herdr" ? "launch" : "brief"} ${ticket}${runtime === "herdr" ? " --runtime herdr" : ""} --profile <name> --reason "<why>"`;

/** First matching label rule; `when` rules defer to the coordinator, otherwise the default or only profile. */
export function routeProfile(
  config: ArmadaConfig,
  labels: string[],
  runtime: ProfileSelectionRuntime = "conductor",
): Route | null {
  const { routing, defaultProfile, profiles } = profileSection(config, runtime);
  for (const [i, rule] of routing.entries()) {
    const keys = rule.labels.map(routingLabelKey);
    const label = labels.find((l) => keys.includes(routingLabelKey(l)));
    if (label !== undefined)
      return { name: rule.profile, source: "rule", rule: { index: i + 1, labels: rule.labels, label } };
  }
  if (hasProfileRules(config, runtime)) return null;
  if (defaultProfile) return { name: defaultProfile, source: "default", rule: null };
  const names = Object.keys(profiles);
  return names.length === 1 && names[0] ? { name: names[0], source: "only", rule: null } : null;
}

export function describeRoute(
  route: Route,
  config: ArmadaConfig,
  runtime: ProfileSelectionRuntime = "conductor",
): string {
  const section = profileSection(config, runtime);
  const sectionName = runtime === "herdr" ? "herdr" : "conductor";
  if (route.rule) return `rule ${route.rule.index} of [[${sectionName}.routing]] (label "${route.rule.label}")`;
  if (route.source === "default")
    return section.routing.length
      ? `${sectionName}.default_profile (no routing rule matched)`
      : `${sectionName}.default_profile`;
  return runtime === "herdr" ? "the only Herdr profile in armada.toml" : "the only profile in armada.toml";
}

/** Throws ProfileError when `requested` names no profile. Needs no ticket, so it runs before any network call. */
export function checkRequestedProfile(
  config: ArmadaConfig,
  requested: string | null,
  runtime: ProfileSelectionRuntime = "conductor",
): void {
  const { profiles } = profileSection(config, runtime);
  if (requested === null || Object.hasOwn(profiles, requested)) return;
  const names = Object.keys(profiles);
  throw new ProfileError(
    `no ${runtimeName(runtime)} profile "${requested}" (available: ${names.join(", ") || "none"})`,
  );
}

/**
 * The profile to launch or record: `requested` (`--profile`), else the route.
 * An override of the route needs a reason. Null when armada.toml declares no
 * profile and none was requested.
 */
export function chooseProfile(
  config: ArmadaConfig,
  input: { ticket: string; labels: string[]; requested: string | null; reason: string | null },
  runtime: "herdr",
): HerdrProfileChoice | null;
export function chooseProfile(
  config: ArmadaConfig,
  input: { ticket: string; labels: string[]; requested: string | null; reason: string | null },
  runtime?: "conductor",
): ProfileChoice | null;
export function chooseProfile(
  config: ArmadaConfig,
  input: { ticket: string; labels: string[]; requested: string | null; reason: string | null },
  runtime: ProfileSelectionRuntime,
): ProfileChoice | HerdrProfileChoice | null;
export function chooseProfile(
  config: ArmadaConfig,
  input: { ticket: string; labels: string[]; requested: string | null; reason: string | null },
  runtime: ProfileSelectionRuntime = "conductor",
): ProfileChoice | HerdrProfileChoice | null {
  checkRequestedProfile(config, input.requested, runtime);
  const { profiles } = profileSection(config, runtime);
  // One line: it is recorded in the claim comment.
  const reason = input.reason?.replace(/\s+/g, " ").trim() || null;
  const route = routeProfile(config, input.labels, runtime);
  const semantic = !route && hasProfileRules(config, runtime);
  if (semantic && (input.requested === null || !reason))
    throw new ProfileError(profileChoiceHint(input.ticket, runtime));
  if (input.requested === null) {
    if (route && Object.hasOwn(profiles, route.name))
      return {
        name: route.name,
        profile: profiles[route.name] as ConductorProfile | HerdrProfile,
        source: route.source,
        rule: route.rule,
        routed: route.name,
        reason,
        why: describeRoute(route, config, runtime),
      } as ProfileChoice | HerdrProfileChoice;
    const names = Object.keys(profiles);
    if (!names.length) return null;
    throw new ProfileError(
      `several ${runtimeName(runtime)} profiles and no ${runtime}.default_profile; pass --profile (${names.join(", ")})`,
    );
  }
  const name = input.requested;
  const profile = profiles[name] as ConductorProfile | HerdrProfile;
  if (route?.name === name)
    return {
      name,
      profile,
      source: route.source,
      rule: route.rule,
      routed: name,
      reason,
      why: describeRoute(route, config, runtime),
    } as ProfileChoice | HerdrProfileChoice;
  // Without routing rules the default is only a default: another profile needs no reason.
  if (route && !reason && profileSection(config, runtime).routing.length)
    throw new ProfileError(
      `${input.ticket} is routed to "${route.name}" by ${describeRoute(route, config, runtime)}; say why "${name}" instead with --reason "<why>"`,
    );
  const why = semantic
    ? `Chosen by the coordinator: ${reason}`
    : `--profile${route ? `, instead of "${route.name}" from ${describeRoute(route, config, runtime)}` : ""}${reason ? `: ${reason}` : ""}`;
  return { name, profile, source: "requested", rule: null, routed: route?.name ?? null, reason, why } as
    | ProfileChoice
    | HerdrProfileChoice;
}

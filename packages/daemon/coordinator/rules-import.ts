import { parse } from "smol-toml";
import * as Value from "typebox/value";
import { labelKey } from "../src/workers/routing.ts";
import { type ProjectRules, rulesSchema } from "./rules.ts";

const table = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected TOML table");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected nonempty string");
  return value.trim();
};

/** V1's routing/profile/policy subset, copied rather than importing core's repository configuration.
 * No filesystem access, provider lookup, secret import or inference of Conductor's machine/VM.
 * Unrelated V1 tables are intentionally outside this import.
 */
export function importV1Rules(body: string): ProjectRules {
  const raw = parse(body);
  const hosted = table(raw.plugins ?? {}).conductor;
  const plugin = hosted === undefined ? undefined : table(hosted);
  const conductor = plugin
    ? { profiles: plugin.profiles, routing: plugin.routing, default_profile: plugin.defaultProfile }
    : table(raw.conductor ?? {});
  // Two V1 runtime routing tables have no combined precedence: do not silently drop one.
  if (!plugin && raw.herdr !== undefined) {
    const herdr = table(raw.herdr);
    if (herdr.default_profile !== undefined || herdr.profiles !== undefined || herdr.routing !== undefined)
      throw new Error("Import conductor rules separately; herdr routing needs an explicit V2 choice");
  }
  const profiles = new Map<
    string,
    { target: { cli: "claude" | "codex" | "opencode" | "conductor"; model: string; effort?: string }; when?: string }
  >();
  for (const [name, value] of Object.entries(table(conductor.profiles ?? {}))) {
    const p = table(value);
    const cli = text(p.agent);
    if (cli !== "claude" && cli !== "codex" && cli !== "opencode" && !(plugin && cli === "cursor"))
      throw new Error("Unsupported CLI");
    if (p.runtime !== undefined && p.runtime !== "conductor" && p.runtime !== "claude-code")
      throw new Error("Unsupported V1 runtime");
    if (p.runtime === "claude-code" && cli !== "claude") throw new Error("Invalid Claude Code CLI");
    if (p.fast_mode !== undefined && p.fast_mode !== false) throw new Error("Fast mode needs an explicit V2 choice");
    profiles.set(name, {
      target: {
        cli: plugin ? "conductor" : (cli as "claude" | "codex" | "opencode"),
        model: plugin ? name : text(p.model),
        ...(p.effort === undefined ? {} : { effort: text(p.effort) }),
      },
      ...(p.when === undefined ? {} : { when: text(p.when) }),
    });
  }
  const profile = (name: unknown) => {
    const p = profiles.get(text(name));
    if (!p) throw new Error("Unknown profile");
    return p.target;
  };
  const routes = conductor.routing ?? [];
  if (!Array.isArray(routes)) throw new Error("Expected routing array");
  const routing: NonNullable<ProjectRules["routing"]> = routes.map((value) => {
    const r = table(value);
    if (!Array.isArray(r.labels) || !r.labels.length) throw new Error("Expected labels");
    // V1 ignores case/spaces/punctuation at match time; reject punctuation-only names as V1 does.
    const labels = r.labels.map(text);
    if (labels.some((label) => !/[\p{L}\p{M}\p{N}]/u.test(label.normalize("NFKC")))) throw new Error("Invalid label");
    return { labels, ...profile(r.profile) };
  });
  // Label routes take precedence. V1's profile.when describes work for the coordinator to judge.
  for (const p of profiles.values()) if (p.when) routing.push({ when: p.when, ...p.target });
  if (routes.length && conductor.default_profile === undefined && !routing.some((r) => "when" in r))
    throw new Error("V1 routing requires a fallback or profile.when");
  const policy = table(raw.policy ?? {});
  if (policy.silence_minutes !== undefined && policy.silent_after_minutes !== undefined)
    throw new Error("Duplicate silence policy");
  // V1 defaults, copied from CONFIG_DEFAULTS in core/src/config.ts.
  const gates = table(raw.gates ?? {});
  const result: ProjectRules = {
    ...(raw.gates === undefined
      ? {}
      : {
          gates: {
            requiredChecks: (gates.required_checks ?? []) as string[],
            localCommands: (gates.local_commands ?? []) as string[],
          },
        }),
    routing,
    ...(conductor.default_profile === undefined ? {} : { defaultRoute: profile(conductor.default_profile) }),
    policy: {
      ...(policy.plans === undefined ? {} : { plans: policy.plans as "approve" | "pre-approved" }),
      ...(policy.approval_label === undefined ? {} : { approvalLabel: text(policy.approval_label) }),
      ...(policy.pre_approved_label === undefined ? {} : { preApprovedLabel: text(policy.pre_approved_label) }),
      silenceMinutes: (policy.silence_minutes ?? policy.silent_after_minutes ?? 15) as number,
      quietMinutes: (policy.quiet_minutes ?? 45) as number,
      maxWorkers: policy.max_workers === undefined ? null : (policy.max_workers as number),
    },
  };
  if (!Value.Check(rulesSchema, result)) throw new Error("Invalid imported rules");
  // V1 core/config.ts rejects normalized collisions, including a collision with an omitted default.
  if (
    labelKey(result.policy?.approvalLabel ?? "needs-plan-approval") ===
    labelKey(result.policy?.preApprovedLabel ?? "plan-approved")
  )
    throw new Error("Plan labels must name different labels");
  return result;
}

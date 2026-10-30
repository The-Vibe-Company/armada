import type { ProjectRules, Ticket } from "@armada/protocol";

// Copied from V1 core/src/config.ts routingLabelKey and core/src/routing.ts routeProfile.
const labelKey = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, "");
export function workerRoute(rules: ProjectRules | undefined, ticket: Ticket, args: { rule?: number; reason?: string }) {
  if (args.rule !== undefined) {
    const selected = rules?.routing?.[args.rule - 1];
    if (!selected || !("when" in selected) || !args.reason?.trim())
      throw new Error("A semantic route needs its declared rule number and a reason");
    return selected;
  }
  for (const rule of rules?.routing ?? []) {
    if ("when" in rule) throw new Error("A semantic routing rule needs a rule number and reason");
    if (!ticket.labels) throw new Error("Label routing requires a current tracker label reading");
    const labels = ticket.labels.map(labelKey);
    if (rule.labels.some((label) => labels.includes(labelKey(label)))) return rule;
  }
  if (!rules?.defaultRoute) throw new Error("Project needs a runtime defaultRoute");
  return rules.defaultRoute;
}

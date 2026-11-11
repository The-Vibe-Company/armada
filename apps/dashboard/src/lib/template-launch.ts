import type { MachineSizePolicy } from "@armada/core";
import type { GoldenRow } from "./data/goldens.ts";
import { goldenSizing } from "./machine-size.ts";
import { goldenRepositoryDirs } from "./repository-context.ts";
import {
  agentSummary,
  type TemplateDefinition,
  type TemplateItem,
  type TemplateLookups,
  templateProblems,
} from "./templates.ts";

/** What a launch from a template needs to know, built on the server from the template and its environment. */
export type TemplateLaunchTarget = {
  id: string;
  orgId: string;
  name: string;
  revision: number;
  definition: TemplateDefinition;
  /** The environment's name, null when it is no longer visible. */
  goldenName: string | null;
  repositories: readonly string[];
  /** Present when the server can take a size for this environment. */
  sizing?: { policy: MachineSizePolicy | null };
  /** The tools' names, in the revision's order. */
  tools: string[];
  /** Why it cannot launch now, or null. */
  blocker: string | null;
  /** "Claude Code · Opus 5.5 · High". */
  agent: string;
};

/**
 * What the launch dialog needs, built on the server from the template and the environment it names. Null when its
 * revision could not be read: nothing is launched from choices the page cannot show.
 */
export function launchTarget(
  item: TemplateItem,
  goldens: readonly Pick<GoldenRow, "id" | "name" | "provider" | "config" | "size_policy">[],
  lookups: TemplateLookups,
): TemplateLaunchTarget | null {
  if (!item.revision) return null;
  const definition = item.revision.definition;
  const blocker = templateProblems(definition, lookups)[0]?.text ?? null;
  const golden = goldens.find((row) => row.id === definition.goldenId && row.provider === definition.provider);
  const repositories = golden ? goldenRepositoryDirs(golden.config) : [];
  const sizing = golden ? goldenSizing(golden, repositories) : null;
  return {
    id: item.id,
    orgId: item.orgId,
    name: item.name,
    revision: item.revision.revision,
    definition,
    goldenName: golden?.name ?? null,
    repositories,
    ...(sizing?.kind === "ready" ? { sizing: { policy: sizing.policy } } : {}),
    tools: definition.connections.map(
      (id) => lookups.connections?.find((connection) => connection.id === id)?.name ?? "Unavailable tool",
    ),
    blocker,
    agent: agentSummary(definition),
  };
}

// The tracker labels the fleet protocol needs: one single-select group for the
// agent phase and one for the agent runtime, plus plain policy plan labels. `armada
// doctor` reads them and `armada init` creates what is missing.
import type { ArmadaConfig } from "./config.ts";
import type { HttpRetryOptions } from "./http.ts";
import { type Fetch, gql, LinearError } from "./linear.ts";
import type { Check } from "./setup.ts";
import { LABEL_PHASES } from "./types.ts";

export interface LabelOptions extends HttpRetryOptions {
  apiKey: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

export interface LabelGroupState {
  name: string;
  /** Id of the group label, or null when the group does not exist. */
  id: string | null;
  /** "team" when the group belongs to the program root's team, "workspace" when shared. */
  scope: "team" | "workspace" | null;
  /** Values the protocol needs that the group lacks, in protocol order. */
  missing: string[];
}

export interface LabelState {
  /** Team of the program root; new groups are created there. */
  team: { id: string; key: string };
  groups: LabelGroupState[];
  /** Plain policy labels applicable to the program root's team. */
  labels: { name: string; id: string | null }[];
}

/** The groups and values `config` asks for: phases are the protocol's, runtimes come from armada.toml. */
export function requiredLabels(config: ArmadaConfig): { name: string; values: string[] }[] {
  return [
    { name: config.tracker.labels.phaseGroup, values: [...LABEL_PHASES] },
    { name: config.tracker.labels.runtimeGroup, values: config.tracker.labels.runtimes },
  ];
}

interface RawGroup {
  id: string;
  name: string;
  isGroup: boolean;
  team: { id: string } | null;
  children: { nodes: { name: string }[] };
}

const LABELS_QUERY = /* GraphQL */ `
  query Labels($root: String!, $filter: IssueLabelFilter) {
    issue(id: $root) { team { id key } }
    issueLabels(first: 50, filter: $filter) {
      nodes { id name isGroup team { id } children(first: 100) { nodes { name } } }
    }
  }`;

/** Reads the groups and plain plan labels `config` needs, as seen from the program root's team. */
export async function readLabels(config: ArmadaConfig, opts: LabelOptions): Promise<LabelState> {
  const wanted = requiredLabels(config);
  const planLabels = [config.policy.preApprovedLabel, config.policy.approvalLabel].filter(Boolean);
  const data = await gql<{ issue: { team: { id: string; key: string } } | null; issueLabels: { nodes: RawGroup[] } }>(
    { ...opts, retry: true },
    LABELS_QUERY,
    {
      root: config.tracker.programRoot,
      filter: { or: [...wanted.map((g) => g.name), ...planLabels].map((name) => ({ name: { eqIgnoreCase: name } })) },
    },
  );
  if (!data.issue) throw new LinearError(`Linear: program root ${config.tracker.programRoot} not found`);
  const team = data.issue.team;
  const groups = wanted.map((w): LabelGroupState => {
    const candidates = data.issueLabels.nodes.filter((n) => n.isGroup && n.name.toLowerCase() === w.name.toLowerCase());
    // Labels of another team do not apply to this program; the team's own group wins over a shared one.
    const group = candidates.find((n) => n.team?.id === team.id) ?? candidates.find((n) => n.team === null);
    const have = new Set(group?.children.nodes.map((c) => c.name.toLowerCase()) ?? []);
    return {
      name: w.name,
      id: group?.id ?? null,
      scope: group ? (group.team ? "team" : "workspace") : null,
      missing: w.values.filter((v) => !have.has(v.toLowerCase())),
    };
  });
  const labels = planLabels.map((name) => {
    const candidates = data.issueLabels.nodes.filter((n) => !n.isGroup && n.name.toLowerCase() === name.toLowerCase());
    const label = candidates.find((n) => n.team?.id === team.id) ?? candidates.find((n) => n.team === null);
    return { name, id: label?.id ?? null };
  });
  return { team, groups, labels };
}

export function checkLabels(state: LabelState): Check[] {
  const groups = state.groups.map((g): Check => {
    const id = `labels:${g.name}`;
    if (!g.id)
      return {
        id,
        level: "error",
        message: `label group "${g.name}" does not exist in Linear team ${state.team.key}`,
        fix: "run `armada init` to create it with every value",
      };
    if (g.missing.length)
      return {
        id,
        level: "error",
        message: `label group "${g.name}" lacks ${g.missing.map((v) => `"${v}"`).join(", ")}`,
        fix: "run `armada init` to add the missing values",
      };
    return { id, level: "ok", message: `label group "${g.name}" has every value`, fix: null };
  });
  return [
    ...groups,
    ...state.labels.map(
      (label): Check => ({
        id: `labels:${label.name}`,
        level: label.id ? "ok" : "error",
        message: label.id
          ? `label "${label.name}" exists in Linear`
          : `label "${label.name}" does not exist in Linear team ${state.team.key}`,
        fix: label.id ? null : "run `armada init` to create it",
      }),
    ),
  ];
}

const CREATE_LABEL = /* GraphQL */ `
  mutation CreateLabel($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) { success issueLabel { id } }
  }`;

async function createLabel(opts: LabelOptions, input: Record<string, unknown>): Promise<string> {
  const data = await gql<{ issueLabelCreate: { success: boolean; issueLabel: { id: string } | null } }>(
    opts,
    CREATE_LABEL,
    { input },
  );
  const created = data.issueLabelCreate.issueLabel;
  if (!data.issueLabelCreate.success || !created) throw new LinearError(`Linear refused to create label ${input.name}`);
  return created.id;
}

/**
 * Creates every missing group (in the program root's team) and value (next to
 * its group), and plain plan labels in the program root's team. Returns one
 * line per label created, e.g. `Agent phase / planning`.
 */
export async function createMissingLabels(state: LabelState, opts: LabelOptions): Promise<string[]> {
  const created: string[] = [];
  for (const g of state.groups) {
    let groupId = g.id;
    let teamId: string | null = g.scope === "workspace" ? null : state.team.id;
    if (!groupId) {
      groupId = await createLabel(opts, {
        name: g.name,
        teamId: state.team.id,
        isGroup: true,
        groupType: "singleSelect",
      });
      teamId = state.team.id;
      created.push(g.name);
    }
    for (const value of g.missing) {
      await createLabel(opts, { name: value, parentId: groupId, ...(teamId ? { teamId } : {}) });
      created.push(`${g.name} / ${value}`);
    }
  }
  for (const label of state.labels) {
    if (label.id) continue;
    await createLabel(opts, { name: label.name, teamId: state.team.id });
    created.push(label.name);
  }
  return created;
}

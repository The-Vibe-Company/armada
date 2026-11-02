import type { TrackerCreateRequest, TrackerMutationRequest, TrackerUpdateRequest } from "@armada/plugin-api";
import { LinearReadError } from "./errors.ts";

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
export interface Label {
  id: string;
  name: string;
  parent: { name: string } | null;
  team?: { id: string } | null;
}
interface State {
  id: string;
  type: string;
  position?: number;
}
interface Team {
  id: string;
  states: Connection<State>;
}
interface Ancestor {
  id: string;
  parent?: Ancestor | null;
}
interface Recent extends Ancestor {
  identifier: string;
  url: string;
  title: string;
  description?: string | null;
  createdAt: string;
}
interface Relation {
  id: string;
  type: string;
  issue: { identifier: string };
}
export type LinearRequest = <T>(
  query: string,
  variables: object,
  signal?: AbortSignal,
  beforeWrite?: () => void,
) => Promise<T>;
const HOUR = 3_600_000;
const stateFields = "id states(first: 100) { nodes { id type position } pageInfo { hasNextPage endCursor } }";
const labelFields = "id name parent { name } team { id }";
// Linear has no recursive ancestor selection. Bound both the candidate page and its
// ancestry evidence: deeper/unknown ancestry is never treated as a positive match.
const ancestors = Array.from({ length: 10 }).reduce<string>((fields) => `id parent { ${fields} }`, "id");

export function applicableLabel(labels: Label[], team: string): Label | undefined {
  return labels.find((label) => label.team?.id === team) ?? labels.find((label) => !label.team);
}

/** Mutation requests use the same gateway, quota and cooldown as reader requests. */
export function linearMutations(options: { rootId: string; now: () => Date; request: LinearRequest }) {
  const { request } = options;
  let root: { id: string; team: Team } | undefined;
  async function program(signal?: AbortSignal) {
    if (!root) {
      const data = await request<{ issue: { id: string; team: Team } | null }>(
        `query MutationRoot($id: String!) { issue(id: $id) { id team { ${stateFields} } } }`,
        { id: options.rootId },
        signal,
      );
      if (!data.issue?.id || !data.issue.team?.id) throw new LinearReadError("Linear program root unavailable");
      root = data.issue;
    }
    return root;
  }
  async function pages<T>(
    query: string,
    variables: object,
    select: (data: unknown) => Connection<T>,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const nodes: T[] = [];
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let i = 0; i < 100; i++) {
      const connection = select(await request(query, { ...variables, after }, signal));
      if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean")
        throw new LinearReadError("Linear mutation lookup incomplete");
      nodes.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) return nodes;
      after = connection.pageInfo.endCursor;
      if (!after || cursors.has(after)) break;
      cursors.add(after);
    }
    throw new LinearReadError("Linear mutation lookup pagination did not advance");
  }
  async function labels(names: string[], team: string, signal?: AbortSignal) {
    if (!names.length) return [];
    const candidates = await pages<Label>(
      `query TicketLabels($names: [String!]!, $after: String) {
        issueLabels(first: 100, after: $after, filter: { name: { in: $names } }) {
          nodes { ${labelFields} } pageInfo { hasNextPage endCursor }
        }
      }`,
      { names: [...new Set(names)] },
      (data) => (data as { issueLabels: Connection<Label> }).issueLabels,
      signal,
    );
    return [...new Set(names)].map((name) => {
      const label = applicableLabel(
        candidates.filter((label) => label.name === name),
        team,
      );
      if (!label) throw new LinearReadError(`Linear label not found: ${name}`);
      return label.id;
    });
  }
  function state(team: Team, type: string): string {
    if (team.states?.pageInfo?.hasNextPage !== false || !Array.isArray(team.states.nodes))
      throw new LinearReadError("Linear workflow states incomplete");
    const found = team.states.nodes
      .filter((s) => s.type === type)
      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))[0];
    if (!found?.id) throw new LinearReadError(`Linear workflow state not found: ${type}`);
    return found.id;
  }
  async function blockers(ticket: string, desired: string[], existing: Relation[], mutation: TrackerMutationRequest) {
    for (const relation of existing.filter((r) => r.type === "blocks" && !desired.includes(r.issue.identifier))) {
      const data = await request<{ issueRelationDelete: { success: boolean } }>(
        "mutation RemoveBlocker($id: String!) { issueRelationDelete(id: $id) { success } }",
        { id: relation.id },
        mutation.signal,
        mutation.beforeWrite,
      );
      if (!data.issueRelationDelete?.success) throw new LinearReadError("Linear refused to remove blocker relation");
    }
    for (const blocker of new Set(desired)) {
      if (existing.some((r) => r.type === "blocks" && r.issue.identifier === blocker)) continue;
      const data = await request<{ issueRelationCreate: { success: boolean } }>(
        "mutation AddBlocker($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }",
        { input: { issueId: blocker, relatedIssueId: ticket, type: "blocks" } },
        mutation.signal,
        mutation.beforeWrite,
      );
      if (!data.issueRelationCreate?.success)
        throw new LinearReadError(`Linear refused blocker relation from ${blocker}`);
    }
  }
  const ticketBlockers = (ticket: string, signal?: AbortSignal) =>
    pages<Relation>(
      `query TicketBlockers($id: String!, $after: String) { issue(id: $id) { inverseRelations(first: 100, after: $after) {
      nodes { id type issue { identifier } } pageInfo { hasNextPage endCursor }
    } } }`,
      { id: ticket },
      (data) => (data as { issue: { inverseRelations: Connection<Relation> } }).issue?.inverseRelations,
      signal,
    );
  return {
    async create(mutation: TrackerCreateRequest): Promise<{ id: string; url: string }> {
      const { title, description, signal, beforeWrite } = mutation;
      const programRoot = await program(signal);
      const since = options.now().getTime() - HOUR;
      const recent = await request<{ issues: { nodes: Recent[] } }>(
        `query RecentTickets($team: ID!, $title: String!, $since: DateTimeOrDuration!) {
          issues(first: 50, filter: { team: { id: { eq: $team } }, title: { eq: $title }, createdAt: { gte: $since } }) {
            nodes { id identifier url title description createdAt parent { ${ancestors} } }
          }
        }`,
        { team: programRoot.team.id, title, since: new Date(since).toISOString() },
        signal,
      );
      if (!Array.isArray(recent.issues?.nodes)) throw new LinearReadError("Linear recent ticket lookup incomplete");
      const duplicate = recent.issues.nodes.find((issue) => {
        if (
          issue.title !== title ||
          (issue.description ?? "") !== description ||
          Date.parse(issue.createdAt) < since ||
          !Number.isFinite(Date.parse(issue.createdAt))
        )
          return false;
        let parent = issue.parent;
        for (let depth = 0; parent && depth < 11; depth++, parent = parent.parent)
          if (parent.id === programRoot.id) return true;
        return false;
      });
      if (duplicate) {
        if (mutation.blockers?.length) {
          const existing = await ticketBlockers(duplicate.id, signal);
          // Dedup may recover an issueCreate whose later relation writes failed.
          // Add the requested dependencies without changing pre-existing blockers.
          const desired = [
            ...existing.filter((relation) => relation.type === "blocks").map((relation) => relation.issue.identifier),
            ...mutation.blockers,
          ];
          await blockers(duplicate.id, desired, existing, mutation);
        }
        return { id: duplicate.identifier, url: duplicate.url };
      }
      const labelIds = await labels(mutation.labels, programRoot.team.id, signal);
      const data = await request<{
        issueCreate: { success: boolean; issue?: { id: string; identifier: string; url: string } };
      }>(
        "mutation CreateTicket($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
        {
          input: {
            teamId: programRoot.team.id,
            title,
            description,
            parentId: mutation.parent ?? programRoot.id,
            labelIds,
            ...(mutation.state ? { stateId: state(programRoot.team, mutation.state) } : {}),
          },
        },
        signal,
        beforeWrite,
      );
      const issue = data.issueCreate?.issue;
      if (!data.issueCreate?.success || !issue?.id || !issue.identifier || !issue.url)
        throw new LinearReadError("Linear refused ticket creation");
      await blockers(issue.id, mutation.blockers ?? [], [], mutation);
      return { id: issue.identifier, url: issue.url };
    },
    async update(mutation: TrackerUpdateRequest): Promise<void> {
      const { patch, signal, beforeWrite } = mutation;
      const data = await request<{
        issue: { id: string; team: Team; labels: Connection<Label>; inverseRelations: Connection<Relation> } | null;
      }>(
        `query EditTicket($id: String!) { issue(id: $id) {
          id team { ${stateFields} }
          labels(first: 250) { nodes { ${labelFields} } pageInfo { hasNextPage endCursor } }
          inverseRelations(first: 100) { nodes { id type issue { identifier } } pageInfo { hasNextPage endCursor } }
        } }`,
        { id: mutation.ticket },
        signal,
      );
      const issue = data.issue;
      if (!issue?.id || !issue.team?.id) throw new LinearReadError("Linear ticket unavailable");
      const input: Record<string, unknown> = {};
      if (patch.title !== undefined) input.title = patch.title;
      if (patch.description !== undefined) input.description = patch.description;
      if (patch.parent !== undefined) input.parentId = patch.parent;
      if (patch.state !== undefined) input.stateId = state(issue.team, patch.state);
      if (patch.labels !== undefined) {
        if (issue.labels?.pageInfo?.hasNextPage !== false || !Array.isArray(issue.labels.nodes))
          throw new LinearReadError("Linear ticket labels incomplete");
        const added = patch.labels.filter((name) => !issue.labels.nodes.some((label) => label.name === name));
        input.addedLabelIds = await labels(added, issue.team.id, signal);
        input.removedLabelIds = issue.labels.nodes
          .filter((label) => !patch.labels?.includes(label.name))
          .map((label) => label.id);
      }
      let existing: Relation[] = [];
      if (patch.blockers !== undefined) {
        existing =
          issue.inverseRelations?.pageInfo?.hasNextPage === false
            ? issue.inverseRelations.nodes
            : await ticketBlockers(issue.id, signal);
      }
      if (Object.keys(input).length) {
        const changed = await request<{ issueUpdate: { success: boolean } }>(
          "mutation UpdateTicket($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
          { id: issue.id, input },
          signal,
          beforeWrite,
        );
        if (!changed.issueUpdate?.success) throw new LinearReadError("Linear refused ticket update");
      }
      if (patch.blockers !== undefined) await blockers(issue.id, patch.blockers, existing, mutation);
    },
  };
}

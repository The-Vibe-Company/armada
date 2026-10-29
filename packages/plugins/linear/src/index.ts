import type { FleetEvent } from "@armada/daemon/events";
import type { PluginContext, TrackerProvider } from "@armada/plugin-api";
import { linearTracker } from "./linear/index.ts";
import { TrackerPoller } from "./poll.ts";

interface Config {
  endpoint?: string;
  projects?: Record<string, { programRoot: string; phaseGroup?: string }>;
}

interface Label {
  id: string;
  name: string;
  parent: { name: string } | null;
  team?: { id: string } | null;
}
interface Labels {
  nodes: Label[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}
interface WriteData {
  issue?: { id: string; team: { id: string }; labels: Labels } | null;
  issueLabels?: Labels;
  issueUpdate?: { success: boolean };
  commentCreate?: { success: boolean };
}

export function activate(ctx: PluginContext): void {
  const config = ctx.config.tracker?.linear as Config;
  const readers = new Map<string, TrackerPoller>();
  const provider: TrackerProvider = {
    async read({ project, signal }) {
      signal?.throwIfAborted();
      const settings = config.projects?.[project];
      if (!settings) return;
      let reader = readers.get(project);
      if (!reader) {
        reader = new TrackerPoller({
          project,
          tracker: linearTracker({
            project,
            rootId: settings.programRoot,
            phaseGroup: settings.phaseGroup ?? "Agent phase",
            endpoint: config.endpoint,
            secrets: async () => ctx.secrets.get("LINEAR_API_KEY"),
            fetch: (...args) => fetch(...args),
            now: () => new Date(),
          }),
          store: {
            append: async (event) => (await ctx.events.append(event)) as FleetEvent,
            readSince: async (after) => (await ctx.events.read(project, after)) as FleetEvent[],
          },
          clock: {
            now: () => new Date(),
            set(callback, delay) {
              const timer = setTimeout(callback, delay);
              return () => clearTimeout(timer);
            },
          },
        });
        readers.set(project, reader);
      }
      const stop = () => reader.stop();
      signal?.addEventListener("abort", stop, { once: true });
      try {
        await reader.readNow();
        signal?.throwIfAborted();
        if (reader.status.error) throw new Error(reader.status.error);
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    },
    async write({ project, ticket, phase, comment, signal }) {
      try {
        if (!config.projects?.[project]) throw new Error();
        const key = await ctx.secrets.get("LINEAR_API_KEY");
        if (!key) throw new Error();
        const gql = async (query: string, variables: object): Promise<WriteData> => {
          signal?.throwIfAborted();
          const response = await fetch(config.endpoint ?? "https://api.linear.app/graphql", {
            method: "POST",
            redirect: "error",
            signal,
            headers: { "Content-Type": "application/json", Authorization: key },
            body: JSON.stringify({ query, variables }),
          });
          const body = (await response.json()) as { data?: WriteData; errors?: unknown[] };
          signal?.throwIfAborted();
          if (!response.ok || body.errors?.length || !body.data) throw new Error();
          return body.data;
        };
        // Keep every non-phase label, replacing only this project's phase group.
        const data = await gql(
          `query WriteIssue($id: String!) {
          issue(id: $id) { id team { id }
            labels(first: 250) { nodes { id name parent { name } } pageInfo { hasNextPage } } }
        }`,
          { id: ticket },
        );
        const issue = data.issue;
        if (!issue?.id || issue.labels.pageInfo.hasNextPage) throw new Error();
        if (phase !== undefined) {
          const group = config.projects[project]?.phaseGroup ?? "Agent phase";
          const candidates: Label[] = [];
          const cursors = new Set<string>();
          let after: string | null = null;
          for (let count = 0; count < 100; count++) {
            const data = await gql(
              `query PhaseLabels($group: String!, $phase: String!, $after: String) {
              issueLabels(first: 100, after: $after, filter: {parent: {name: {eq: $group}}, name: {eq: $phase}}) {
                nodes {id name parent {name} team {id}}
                pageInfo {hasNextPage endCursor}
              }
            }`,
              { group, phase, after },
            );
            const labels = data.issueLabels;
            if (!labels) throw new Error();
            candidates.push(...labels.nodes);
            if (!labels.pageInfo.hasNextPage) break;
            after = labels.pageInfo.endCursor ?? null;
            if (!after || cursors.has(after) || count === 99) throw new Error();
            cursors.add(after);
          }
          const applicable = candidates.filter((label) => label.name === phase && label.parent?.name === group);
          // Match the host label model: this issue's team shadows the workspace label.
          const label =
            applicable.find((label) => label.team?.id === issue.team.id) ?? applicable.find((label) => !label.team);
          if (!label) throw new Error();
          const labelIds = issue.labels.nodes.filter((label) => label.parent?.name !== group).map((label) => label.id);
          const changed = await gql(
            `mutation UpdatePhase($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success }
          }`,
            { id: issue.id, input: { labelIds: [...labelIds, label.id] } },
          );
          if (!changed.issueUpdate?.success) throw new Error();
        }
        if (comment !== undefined) {
          const changed = await gql(
            `mutation PostComment($input: CommentCreateInput!) {
            commentCreate(input: $input) { success }
          }`,
            { input: { issueId: issue.id, body: comment } },
          );
          if (!changed.commentCreate?.success) throw new Error();
        }
      } catch {
        throw new Error("Linear write failed");
      }
    },
  };
  ctx.register.tracker("linear", provider);
}

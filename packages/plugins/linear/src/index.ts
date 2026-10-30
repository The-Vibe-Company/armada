import type { FleetEvent } from "@armada/daemon/events";
import type { PluginContext, TrackerProvider } from "@armada/plugin-api";
import { linearTracker } from "./linear/index.ts";
import { TrackerPoller } from "./poll.ts";

interface Config {
  endpoint?: string;
  projects?: Record<string, { programRoot: string; phaseGroup?: string; runtimeGroup?: string; readyLabel?: string }>;
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
interface WorkflowState {
  id: string;
  name?: string;
  type: string;
  position?: number;
}
interface States {
  nodes: WorkflowState[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}
interface Comments {
  nodes: { id: string; body?: string | null }[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}
interface WriteData {
  issue?: {
    id: string;
    state?: { type: string } | null;
    team: { id: string; states?: States };
    labels: Labels;
    comments?: Comments;
  } | null;
  issueLabels?: Labels;
  issueUpdate?: { success: boolean };
  commentCreate?: { success: boolean; comment?: { id: string } | null };
}

export function activate(ctx: PluginContext): void {
  const config = ctx.config.tracker?.linear as Config;
  const readers = new Map<string, TrackerPoller>();
  const provider: TrackerProvider = {
    async read({ project, signal }) {
      signal?.throwIfAborted();
      const settings = config.projects?.[project];
      if (!settings) throw new Error("Linear project is not configured");
      let reader = readers.get(project);
      if (!reader) {
        reader = new TrackerPoller({
          project,
          tracker: linearTracker({
            project,
            rootId: settings.programRoot,
            phaseGroup: settings.phaseGroup ?? "Agent phase",
            endpoint: config.endpoint,
            secrets: async () => ctx.secrets.get("LINEAR_API_KEY", project),
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
    async write({ project, ticket, phase, state, comment, commentId, signal, beforeWrite }) {
      try {
        const settings = config.projects?.[project];
        if (!settings || (state !== undefined && state !== "completed")) throw new Error();
        if (commentId !== undefined && (!comment || !commentId.trim() || /\s/.test(commentId))) throw new Error();
        const key = await ctx.secrets.get("LINEAR_API_KEY", project);
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
          issue(id: $id) {
            id state { type }
            team { id states(first: 100) { nodes { id name type position } pageInfo { hasNextPage endCursor } } }
            labels(first: 250) { nodes { id name parent { name } } pageInfo { hasNextPage endCursor } }
            comments(first: 100) { nodes { id body } pageInfo { hasNextPage endCursor } }
          }
        }`,
          { id: ticket },
        );
        const issue = data.issue;
        if (
          !issue?.id ||
          !issue.labels ||
          typeof issue.labels.pageInfo?.hasNextPage !== "boolean" ||
          issue.labels.pageInfo.hasNextPage ||
          !Array.isArray(issue.labels.nodes)
        )
          throw new Error();
        let existingComment: { id: string; body?: string | null } | undefined;
        if (commentId !== undefined) {
          if (
            !issue.comments ||
            typeof issue.comments.pageInfo?.hasNextPage !== "boolean" ||
            !Array.isArray(issue.comments.nodes)
          )
            throw new Error();
          const comments = [...issue.comments.nodes];
          const cursors = new Set<string>();
          let after = issue.comments.pageInfo.endCursor ?? null;
          for (let count = 0; issue.comments.pageInfo.hasNextPage; count++) {
            if (!after || cursors.has(after) || count >= 100) throw new Error();
            cursors.add(after);
            const more = await gql(
              `query MoreWriteComments($id: String!, $after: String) {
              issue(id: $id) { comments(first: 100, after: $after) {
                nodes { id body } pageInfo { hasNextPage endCursor }
              } }
            }`,
              { id: issue.id, after },
            );
            if (
              !more.issue?.comments ||
              typeof more.issue.comments.pageInfo?.hasNextPage !== "boolean" ||
              !Array.isArray(more.issue.comments.nodes)
            )
              throw new Error();
            comments.push(...more.issue.comments.nodes);
            if (!more.issue.comments.pageInfo.hasNextPage) {
              after = null;
              break;
            }
            after = more.issue.comments.pageInfo.endCursor ?? null;
          }
          existingComment = comments.find((candidate) => candidate.id === commentId);
          if (existingComment?.body !== undefined && existingComment.body !== null && existingComment.body !== comment)
            throw new Error();
        }
        if (phase !== undefined) {
          const group = settings.phaseGroup ?? "Agent phase";
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
          beforeWrite?.();
          const changed = await gql(
            `mutation UpdatePhase($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success }
          }`,
            { id: issue.id, input: { labelIds: [...labelIds, label.id] } },
          );
          if (!changed.issueUpdate?.success) throw new Error();
        }
        if (state === "completed") {
          const states = issue.team.states;
          if (
            !states ||
            typeof states.pageInfo?.hasNextPage !== "boolean" ||
            states.pageInfo.hasNextPage ||
            !Array.isArray(states.nodes)
          )
            throw new Error();
          const done = [...states.nodes]
            .filter(
              (candidate) =>
                candidate &&
                typeof candidate.id === "string" &&
                candidate.id &&
                typeof candidate.type === "string" &&
                candidate.type.toLowerCase() === "completed",
            )
            .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER))[0];
          if (!done) throw new Error();
          const phaseGroup = settings.phaseGroup ?? "Agent phase";
          const runtimeGroup = settings.runtimeGroup ?? "Agent runtime";
          const readyLabel = settings.readyLabel ?? "ready-for-agent";
          const removeLabelIds = issue.labels.nodes
            .filter(
              (label) =>
                label.parent?.name === phaseGroup || label.parent?.name === runtimeGroup || label.name === readyLabel,
            )
            .map((label) => label.id);
          const input: Record<string, unknown> = {};
          if (issue.state?.type?.toLowerCase() !== "completed") input.stateId = done.id;
          if (removeLabelIds.length) input.removedLabelIds = removeLabelIds;
          if (Object.keys(input).length) {
            beforeWrite?.();
            const changed = await gql(
              `mutation CompleteIssue($id: String!, $input: IssueUpdateInput!) {
              issueUpdate(id: $id, input: $input) { success }
            }`,
              { id: issue.id, input },
            );
            if (!changed.issueUpdate?.success) throw new Error();
          }
        }
        if (comment !== undefined && !existingComment) {
          beforeWrite?.();
          const changed = await gql(
            `mutation PostComment($input: CommentCreateInput!) {
            commentCreate(input: $input) { success }
          }`,
            { input: { ...(commentId !== undefined ? { id: commentId } : {}), issueId: issue.id, body: comment } },
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

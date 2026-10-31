import type { FleetEvent } from "@armada/daemon/events";
import type { PluginContext, TrackerProvider } from "@armada/plugin-api";
import { linearReaderCheckpointSchema } from "./checkpoint.ts";
import type { LinearBudget } from "./linear/budget.ts";
import { linearTracker } from "./linear/index.ts";
import { TrackerPoller } from "./poll.ts";
import { linearConnection } from "./status.ts";

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

// Scoped project activations share a quota only within the same host event gateway.
// A WeakMap keeps separate daemons/tests isolated and releases retired host state.
const readerPools = new WeakMap<
  PluginContext["events"],
  {
    budgets: Map<string, LinearBudget>;
    pending: Set<Promise<void>>;
  }
>();

export function activate(ctx: PluginContext): void {
  const config = ctx.config.tracker?.linear as Config;
  const readers = new Map<string, TrackerPoller>();
  let pool = readerPools.get(ctx.events);
  if (!pool) {
    pool = { budgets: new Map(), pending: new Set() };
    readerPools.set(ctx.events, pool);
  }
  const { budgets, pending } = pool;
  const trackers = new Map<string, ReturnType<typeof linearTracker>>();
  const trackerFor = (project: string) => {
    let tracker = trackers.get(project);
    if (tracker) return tracker;
    const settings = config.projects?.[project];
    if (!settings) throw new Error("Linear project is not configured");
    tracker = linearTracker({
      project,
      budgets,
      rootId: settings.programRoot,
      phaseGroup: settings.phaseGroup ?? "Agent phase",
      endpoint: config.endpoint,
      secrets: async () => ctx.secrets.get("LINEAR_API_KEY", project),
      fetch: (...args) => fetch(...args),
      now: () => new Date(),
      log: (line) => ctx.log.info(line),
    });
    trackers.set(project, tracker);
    return tracker;
  };
  let restoredBudget: Promise<void> | undefined;
  // Restore only current reader/credential observations. Projects with the same key share
  // a quota, while a missing/unrelated project's key must not block another project's boot.
  const restoreBudget = () => {
    if (restoredBudget) return restoredBudget;
    const attempt = Promise.all(
      Object.keys(config.projects ?? {}).map(async (project) => {
        const tracker = trackerFor(project);
        try {
          await tracker.prepare?.();
        } catch {
          return;
        }
        for (const event of await ctx.events.read(project, 0)) {
          if (event.kind !== "coordinator.checkpoint") continue;
          const parsed = linearReaderCheckpointSchema.safeParse((event.payload as { checkpoint?: unknown }).checkpoint);
          if (parsed.success && parsed.data.quota === tracker.quota && parsed.data.usage)
            tracker.budget?.restore(project, parsed.data.usage);
        }
      }),
    ).then(() => {});
    restoredBudget = attempt;
    pending.add(attempt);
    void attempt.then(
      () => pending.delete(attempt),
      () => {
        pending.delete(attempt);
        if (restoredBudget === attempt) restoredBudget = undefined;
      },
    );
    return attempt;
  };
  const waitForRestore = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, 30_000);
    const canceled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Tracker read timed out")), { once: true });
    });
    try {
      // The shared restoration remains single-flight even when a caller cancels.
      // A later caller can join it; no timed-out generation continues into HTTP.
      await Promise.race([Promise.all([restoreBudget(), ...pending]), canceled]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  };
  const provider: TrackerProvider = {
    ...linearConnection(ctx.secrets, config.endpoint),
    async read({ project, signal }) {
      signal?.throwIfAborted();
      await waitForRestore(signal);
      signal?.throwIfAborted();
      let reader = readers.get(project);
      if (!reader) {
        reader = new TrackerPoller({
          project,
          tracker: trackerFor(project),
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
        const status = reader.status;
        if (status.pausedUntil) return { pausedUntil: status.pausedUntil };
        if (status.error) throw new Error(status.error);
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

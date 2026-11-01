import { LinearBudget } from "./budget.ts";
import { LinearReadError } from "./errors.ts";

export { LinearRateLimitError, LinearReadError } from "./errors.ts";

import { createHash } from "node:crypto";
import { activePhaseSchema } from "@armada/protocol";

// Queries adapted from packages/core/src/linear.ts (V1 Root, Children, Comments,
// Changed, ChangedComments and connection pagination). No V1 runtime imports.
// Provider wire adapter; scheduling/persistence live outside it.
type SecretAccessor = (service: "linear", project: string) => Promise<string | null>;

import type { Tracker, TrackerReading, TrackerTicket } from "../types.ts";

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
interface RawIssue {
  id: string;
  identifier: string;
  updatedAt?: string;
  title: string;
  description?: string;
  branchName?: string;
  inverseRelations?: Connection<{
    type: string;
    issue: { identifier: string; state: { type: TrackerTicket["status"] } };
  }>;
  url: string;
  state: { type: TrackerTicket["status"] };
  assignee: { name: string } | null;
  parent: { identifier: string } | null;
  labels: Connection<{ name: string; parent: { name: string } | null }>;
  attachments: Connection<{ title: string; url: string }>;
}
interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: { name: string } | null;
  issue?: { identifier: string };
}
const fields = `fragment F on Issue {
  id identifier updatedAt title description branchName url state { type }
  inverseRelations(first: 5) { pageInfo { hasNextPage endCursor } nodes { type issue { identifier state { type } } } } assignee { name } parent { identifier }
  labels(first: 10) { pageInfo { hasNextPage endCursor } nodes { name parent { name } } }
  attachments(first: 5) { pageInfo { hasNextPage endCursor } nodes { title url } }
}`;
const commentFields = "id createdAt updatedAt body user { name }";
const rootQuery = `${fields} query Root($id: String!) { issue(id: $id) { ...F } }`;
const childrenQuery = `${fields} query Children($parents: [ID!], $after: String) {
  issues(first: 50, after: $after, filter: { parent: { id: { in: $parents } } }) {
    pageInfo { hasNextPage endCursor } nodes { ...F }
  }
}`;
// Issue/comment deltas share one request; each exhausted connection is omitted on later pages.
const changedQuery = `${fields} query Changed($filter: IssueFilter, $commentFilter: CommentFilter,
  $after: String, $commentsAfter: String, $readIssues: Boolean!, $readComments: Boolean!) {
  issues(first: 25, after: $after, filter: $filter) @include(if: $readIssues) {
    pageInfo { hasNextPage endCursor } nodes { ...F }
  }
  comments(first: 50, after: $commentsAfter, filter: $commentFilter) @include(if: $readComments) {
    pageInfo { hasNextPage endCursor } nodes { ${commentFields} issue { identifier } }
  }
}`;
const commentsQuery = `query Comments($ids: [ID!], $first: Int!) {
  issues(first: $first, filter: { id: { in: $ids } }) {
    nodes { identifier comments(first: 25) { pageInfo { hasNextPage endCursor } nodes { ${commentFields} } } }
  }
}`;
const name = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const chunks = <T>(values: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));

export type LinearFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LinearOptions {
  endpoint?: string;
  project: string;
  rootId: string;
  phaseGroup: string;
  /** Defaults to the host keychain; tests/embedders can supply the same gateway interface. */
  secrets: SecretAccessor;
  fetch: LinearFetch;
  now: () => Date;
  budget?: LinearBudget;
  budgets?: Map<string, LinearBudget>;
  log?: (line: string) => void;
}

/** Credentials stay inside this adapter; errors never quote server bodies or causes. */
export function linearTracker(options: LinearOptions): Tracker {
  let budget = options.budget ?? new LinearBudget(options.now, options.log);
  let key: string | undefined;
  let quota: string | undefined;
  async function prepare(): Promise<void> {
    let apiKey: string | null;
    try {
      apiKey = await options.secrets("linear", options.project);
    } catch {
      throw new LinearReadError("Linear credential lookup failed");
    }
    if (!apiKey) throw new LinearReadError("Linear key missing");
    key = apiKey;
    // High-entropy keys are identified one-way, never persisted or logged. Include the endpoint
    // because a private service's budget is unrelated to Linear's hosted quota.
    quota = createHash("sha256")
      .update(JSON.stringify([options.endpoint ?? "https://api.linear.app/graphql", key]))
      .digest("hex");
    if (options.budgets) {
      budget = options.budgets.get(quota) ?? new LinearBudget(options.now, options.log);
      options.budgets.set(quota, budget);
    }
  }
  return {
    identity: JSON.stringify([
      options.endpoint ?? "https://api.linear.app/graphql",
      options.rootId,
      options.phaseGroup,
    ]),
    get quota() {
      return quota;
    },
    get budget() {
      return budget;
    },
    prepare,
    async read({ previous, signal }) {
      if (!key) await prepare();
      const startedAt = options.now().toISOString();
      async function gql<T>(query: string, variables: object): Promise<T> {
        signal.throwIfAborted();
        budget.beforeRequest(options.project);
        let response: Response;
        try {
          response = await options.fetch(options.endpoint ?? "https://api.linear.app/graphql", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: key as string },
            body: JSON.stringify({ query, variables }),
            signal,
          });
        } catch {
          budget.response(options.project);
          throw new LinearReadError("Linear network request failed");
        }
        budget.response(options.project, response.headers);
        if (response.status === 429 || response.headers.has("retry-after")) throw budget.pause(response.headers);
        let body: { data?: T; errors?: { extensions?: { code?: string } }[] };
        try {
          body = (await response.json()) as typeof body;
        } catch {
          if (!response.ok) throw new LinearReadError(`Linear answered ${response.status}`);
          throw new LinearReadError("Linear returned an invalid or incomplete response");
        }
        if (body.errors?.some((error) => error?.extensions?.code === "RATELIMITED"))
          throw budget.pause(response.headers);
        if (!response.ok) throw new LinearReadError(`Linear answered ${response.status}`);
        if (!body.data || body.errors?.length)
          throw new LinearReadError("Linear returned an invalid or incomplete response");
        return body.data;
      }

      async function pages<T>(query: string, field: "issues" | "comments", variables: object): Promise<T[]> {
        const result: T[] = [];
        const cursors = new Set<string>();
        let after: string | null = null;
        for (let count = 0; count < 100; count++) {
          const data: Record<string, Connection<T>> = await gql<Record<string, Connection<T>>>(query, {
            ...variables,
            after,
          });
          const connection: Connection<T> | undefined = data[field];
          if (!connection?.nodes || !connection.pageInfo) throw new LinearReadError("Linear page is incomplete");
          result.push(...connection.nodes);
          if (!connection.pageInfo.hasNextPage) return result;
          after = connection.pageInfo.endCursor;
          if (!after || cursors.has(after)) throw new LinearReadError("Linear pagination did not advance");
          cursors.add(after);
        }
        throw new LinearReadError("Linear reading exceeds the page limit");
      }
      async function rest<T>(id: string, field: string, selection: string, connection: Connection<T>): Promise<T[]> {
        const nodes = [...connection.nodes];
        const cursors = new Set<string>();
        let info = connection.pageInfo;
        for (let count = 0; info.hasNextPage && count < 100; count++) {
          const after = info.endCursor;
          if (!after || cursors.has(after)) throw new LinearReadError("Linear pagination did not advance");
          cursors.add(after);
          const data = await gql<{ issue: Record<string, Connection<T>> | null }>(
            `query More${field}($id: String!, $after: String) { issue(id: $id) {
              ${field}(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${selection} } }
            } }`,
            { id, after },
          );
          const next = data.issue?.[field];
          if (!next?.pageInfo || !next.nodes) throw new LinearReadError("Linear connection is incomplete");
          nodes.push(...next.nodes);
          info = next.pageInfo;
        }
        if (info.hasNextPage) throw new LinearReadError("Linear reading exceeds the page limit");
        return nodes;
      }
      const raws: RawIssue[] = [];
      const changedComments: RawComment[] = [];
      async function delta(ids: string[], since: string): Promise<void> {
        const cursors = { issues: new Set<string>(), comments: new Set<string>() };
        let issues = true;
        let comments = true;
        let after: string | null = null;
        let commentsAfter: string | null = null;
        for (let count = 0; count < 100 && (issues || comments); count++) {
          const data: { issues?: Connection<RawIssue>; comments?: Connection<RawComment> } = await gql(changedQuery, {
            filter: { updatedAt: { gt: since }, or: [{ id: { in: ids } }, { parent: { id: { in: ids } } }] },
            commentFilter: { updatedAt: { gt: since }, issue: { id: { in: ids } } },
            after,
            commentsAfter,
            readIssues: issues,
            readComments: comments,
          });
          const next = <T>(connection: Connection<T> | undefined, field: "issues" | "comments", target: T[]) => {
            if (!connection?.nodes || !connection.pageInfo) throw new LinearReadError("Linear page is incomplete");
            target.push(...connection.nodes);
            if (!connection.pageInfo.hasNextPage) return null;
            const cursor = connection.pageInfo.endCursor;
            if (!cursor || cursors[field].has(cursor)) throw new LinearReadError("Linear pagination did not advance");
            cursors[field].add(cursor);
            return cursor;
          };
          if (issues) {
            after = next(data.issues, "issues", raws);
            issues = after !== null;
          }
          if (comments) {
            commentsAfter = next(data.comments, "comments", changedComments);
            comments = commentsAfter !== null;
          }
        }
        if (issues || comments) throw new LinearReadError("Linear reading exceeds the page limit");
      }
      const known = new Set(previous?.tickets.map((ticket) => ticket.uuid));
      let parents: string[];
      if (!previous) {
        const { issue } = await gql<{ issue: RawIssue | null }>(rootQuery, { id: options.rootId });
        if (!issue) throw new LinearReadError("Linear program root was not found");
        raws.push(issue);
        parents = [issue.id];
      } else {
        // Read-start watermark + overlap: a change arriving during the preceding read is not lost.
        const since = new Date(Date.parse(previous.startedAt) - 1000).toISOString();
        for (const ids of chunks([...known], 200)) await delta(ids, since);
        parents = raws.filter((ticket) => !known.has(ticket.id)).map((ticket) => ticket.id);
      }
      const seen = new Set([...known, ...raws.map((ticket) => ticket.id)]);
      for (let depth = 0; parents.length; depth++) {
        if (depth >= 100) throw new LinearReadError("Linear program exceeds the depth limit");
        const next: string[] = [];
        for (const ids of chunks(parents, 200)) {
          for (const child of await pages<RawIssue>(childrenQuery, "issues", { parents: ids })) {
            if (seen.has(child.id)) continue;
            seen.add(child.id);
            raws.push(child);
            next.push(child.id);
          }
        }
        parents = next;
      }
      const tickets = new Map(previous?.tickets.map((ticket) => [ticket.uuid, ticket]));
      for (const raw of raws) {
        const labels = await rest(raw.identifier, "labels", "name parent { name }", raw.labels);
        const phase =
          labels
            .filter((label) => label.parent?.name === options.phaseGroup)
            .map((label) => activePhaseSchema.options.find((phase) => name(phase) === name(label.name)))
            .find(Boolean) ?? null;
        tickets.set(raw.id, {
          uuid: raw.id,
          id: raw.identifier,
          title: raw.title,
          description: raw.description ?? "",
          branchName: raw.branchName,
          blockers: raw.inverseRelations
            ? (
                await rest(
                  raw.identifier,
                  "inverseRelations",
                  "type issue { identifier state { type } }",
                  raw.inverseRelations,
                )
              )
                .filter((r) => r.type === "blocks")
                .map((r) => ({ id: r.issue.identifier, status: r.issue.state.type }))
            : undefined,
          url: raw.url,
          status: raw.state.type,
          phase,
          owner: raw.assignee?.name ?? null,
          parent: raw.parent?.identifier ?? null,
          labels: labels.map((label) => label.name),
          attachments: await rest(raw.identifier, "attachments", "title url", raw.attachments),
        });
      }
      // Internal blocker state arrives through Changed; only external blockers need a small
      // targeted read. Batch aliases once per unique blocker, without issue detail connections.
      const states = new Map([...tickets.values()].map((ticket) => [ticket.id, ticket.status]));
      const external = [...new Set([...tickets.values()].flatMap((t) => t.blockers?.map((b) => b.id) ?? []))].filter(
        (id) => !states.has(id),
      );
      for (const ids of chunks(external, 50)) {
        const declaration = ids.map((_, i) => `$id${i}: String!`).join(", ");
        const selection = ids.map((_, i) => `b${i}: issue(id: $id${i}) { identifier state { type } }`).join("\n");
        const data = await gql<Record<string, { identifier: string; state: { type: TrackerTicket["status"] } } | null>>(
          `query Blockers(${declaration}) { ${selection} }`,
          Object.fromEntries(ids.map((id, i) => [`id${i}`, id])),
        );
        for (let i = 0; i < ids.length; i++) {
          const blocker = data[`b${i}`];
          if (
            !blocker ||
            blocker.identifier !== ids[i] ||
            !["triage", "backlog", "unstarted", "started", "completed", "canceled"].includes(blocker.state?.type)
          )
            throw new LinearReadError("Linear blocker evidence is unavailable");
          states.set(blocker.identifier, blocker.state.type);
        }
      }
      for (const [uuid, ticket] of tickets)
        if (ticket.blockers?.length)
          tickets.set(uuid, {
            ...ticket,
            blockers: ticket.blockers.map((b) => ({ ...b, status: states.get(b.id) ?? b.status })),
          });
      // A moved-out ticket and its descendants leave scope even in an incremental reading.
      const scoped = new Set(
        [...tickets.values()].filter((ticket) => ticket.id === options.rootId).map((ticket) => ticket.id),
      );
      for (let count = 0; count < tickets.size; count++) {
        const before = scoped.size;
        for (const ticket of tickets.values()) if (ticket.parent && scoped.has(ticket.parent)) scoped.add(ticket.id);
        if (before === scoped.size) break;
      }
      const kept = [...tickets.values()].filter((ticket) => scoped.has(ticket.id));
      const comments = new Map(
        previous?.comments.filter((comment) => scoped.has(comment.ticket)).map((comment) => [comment.id, comment]),
      );
      function add(raw: RawComment, ticket: string) {
        if (scoped.has(ticket))
          comments.set(raw.id, {
            id: raw.id,
            ticket,
            body: raw.body,
            author: raw.user?.name ?? "Linear",
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
          });
      }
      for (const comment of changedComments) {
        if (!comment.issue) throw new LinearReadError("Linear comment has no ticket");
        add(comment, comment.issue.identifier);
      }
      for (const ids of chunks(
        kept.filter((ticket) => !known.has(ticket.uuid)).map((ticket) => ticket.uuid),
        25,
      )) {
        const data = await gql<{ issues: { nodes: { identifier: string; comments: Connection<RawComment> }[] } }>(
          commentsQuery,
          { ids, first: ids.length },
        );
        if (data.issues.nodes.length !== ids.length) throw new LinearReadError("Linear comments reading is incomplete");
        for (const node of data.issues.nodes)
          for (const comment of await rest(node.identifier, "comments", commentFields, node.comments))
            add(comment, node.identifier);
      }
      signal.throwIfAborted();
      const updatedAt = [
        ...raws.map((raw) => raw.updatedAt),
        ...[...comments.values()].map((c) => c.updatedAt),
        previous?.updatedAt,
      ]
        .filter((at): at is string => typeof at === "string" && Number.isFinite(Date.parse(at)))
        .sort()
        .at(-1);
      return {
        startedAt,
        ...(updatedAt ? { updatedAt } : {}),
        tickets: kept,
        comments: [...comments.values()],
      } satisfies TrackerReading;
    },
  };
}

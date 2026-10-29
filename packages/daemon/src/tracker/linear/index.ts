// Queries adapted from packages/core/src/linear.ts (V1 Root, Children, Comments,
// Changed, ChangedComments and connection pagination). No V1 runtime imports.
// This folder is the future Linear plugin; scheduling/persistence live outside it.
import { readLinearKey, type SecretAccessor } from "../../keychain.ts";
import type { Tracker, TrackerReading, TrackerTicket } from "../types.ts";

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
interface RawIssue {
  id: string;
  identifier: string;
  title: string;
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
  id identifier title url state { type } assignee { name } parent { identifier }
  labels(first: 25) { pageInfo { hasNextPage endCursor } nodes { name parent { name } } }
  attachments(first: 25) { pageInfo { hasNextPage endCursor } nodes { title url } }
}`;
const commentFields = "id createdAt updatedAt body user { name }";
const rootQuery = `${fields} query Root($id: String!) { issue(id: $id) { ...F } }`;
const childrenQuery = `${fields} query Children($parents: [ID!], $after: String) {
  issues(first: 50, after: $after, filter: { parent: { id: { in: $parents } } }) {
    pageInfo { hasNextPage endCursor } nodes { ...F }
  }
}`;
const changedQuery = `${fields} query Changed($filter: IssueFilter, $after: String) {
  issues(first: 50, after: $after, filter: $filter) { pageInfo { hasNextPage endCursor } nodes { ...F } }
}`;
const commentsQuery = `query Comments($ids: [ID!]) {
  issues(first: 50, filter: { id: { in: $ids } }) {
    nodes { identifier comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${commentFields} } } }
  }
}`;
const changedCommentsQuery = `query ChangedComments($filter: CommentFilter, $after: String) {
  comments(first: 100, after: $after, filter: $filter) {
    pageInfo { hasNextPage endCursor } nodes { ${commentFields} issue { identifier } }
  }
}`;
const phases: NonNullable<TrackerTicket["phase"]>[] = [
  "planning",
  "awaiting-approval",
  "implementing",
  "shipping",
  "blocked",
  "ready-to-merge",
  "awaiting-validation",
];
const name = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const chunks = <T>(values: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));

export type LinearFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LinearOptions {
  project: string;
  rootId: string;
  phaseGroup: string;
  /** Defaults to the host keychain; tests/embedders can supply the same gateway interface. */
  secrets?: SecretAccessor;
  fetch: LinearFetch;
  now: () => Date;
}

/** Each read owns its key only until the promises settle; errors never quote server bodies or causes. */
export function linearTracker(options: LinearOptions): Tracker {
  return {
    async read({ previous, signal }) {
      const startedAt = options.now().toISOString();
      const apiKey = await readLinearKey(options.secrets, options.project);
      async function gql<T>(query: string, variables: object): Promise<T> {
        signal.throwIfAborted();
        let response: Response;
        try {
          response = await options.fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: apiKey },
            body: JSON.stringify({ query, variables }),
            signal,
          });
        } catch {
          throw new Error("Linear request failed");
        }
        if (!response.ok) throw new Error(`Linear request failed (HTTP ${response.status})`);
        try {
          const body = (await response.json()) as { data?: T; errors?: unknown[] };
          if (!body.data || body.errors?.length) throw new Error();
          return body.data;
        } catch {
          throw new Error("Linear returned an invalid or incomplete response");
        }
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
          if (!connection?.nodes || !connection.pageInfo) throw new Error("Linear page is incomplete");
          result.push(...connection.nodes);
          if (!connection.pageInfo.hasNextPage) return result;
          after = connection.pageInfo.endCursor;
          if (!after || cursors.has(after)) throw new Error("Linear pagination did not advance");
          cursors.add(after);
        }
        throw new Error("Linear reading exceeds the page limit");
      }
      async function rest<T>(id: string, field: string, selection: string, connection: Connection<T>): Promise<T[]> {
        const nodes = [...connection.nodes];
        const cursors = new Set<string>();
        let info = connection.pageInfo;
        for (let count = 0; info.hasNextPage && count < 100; count++) {
          const after = info.endCursor;
          if (!after || cursors.has(after)) throw new Error("Linear pagination did not advance");
          cursors.add(after);
          const data = await gql<{ issue: Record<string, Connection<T>> | null }>(
            `query More${field}($id: String!, $after: String) { issue(id: $id) {
              ${field}(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${selection} } }
            } }`,
            { id, after },
          );
          const next = data.issue?.[field];
          if (!next?.pageInfo || !next.nodes) throw new Error("Linear connection is incomplete");
          nodes.push(...next.nodes);
          info = next.pageInfo;
        }
        if (info.hasNextPage) throw new Error("Linear reading exceeds the page limit");
        return nodes;
      }
      const raws: RawIssue[] = [];
      const known = new Set(previous?.tickets.map((ticket) => ticket.uuid));
      let parents: string[];
      if (!previous) {
        const { issue } = await gql<{ issue: RawIssue | null }>(rootQuery, { id: options.rootId });
        if (!issue) throw new Error("Linear program root was not found");
        raws.push(issue);
        parents = [issue.id];
      } else {
        // Read-start watermark + overlap: a change arriving during the preceding read is not lost.
        const since = new Date(Date.parse(previous.startedAt) - 1000).toISOString();
        for (const ids of chunks([...known], 200))
          raws.push(
            ...(await pages<RawIssue>(changedQuery, "issues", {
              filter: { updatedAt: { gt: since }, or: [{ id: { in: ids } }, { parent: { id: { in: ids } } }] },
            })),
          );
        parents = raws.filter((ticket) => !known.has(ticket.id)).map((ticket) => ticket.id);
      }
      const seen = new Set([...known, ...raws.map((ticket) => ticket.id)]);
      for (let depth = 0; parents.length; depth++) {
        if (depth >= 100) throw new Error("Linear program exceeds the depth limit");
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
            .map((label) => phases.find((phase) => name(phase) === name(label.name)))
            .find(Boolean) ?? null;
        tickets.set(raw.id, {
          uuid: raw.id,
          id: raw.identifier,
          title: raw.title,
          url: raw.url,
          status: raw.state.type,
          phase,
          owner: raw.assignee?.name ?? null,
          parent: raw.parent?.identifier ?? null,
          labels: labels.map((label) => label.name),
          attachments: await rest(raw.identifier, "attachments", "title url", raw.attachments),
        });
      }
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
      if (previous) {
        for (const ids of chunks(
          kept.filter((ticket) => known.has(ticket.uuid)).map((ticket) => ticket.uuid),
          200,
        ))
          for (const comment of await pages<RawComment>(changedCommentsQuery, "comments", {
            filter: {
              updatedAt: { gt: new Date(Date.parse(previous.startedAt) - 1000).toISOString() },
              issue: { id: { in: ids } },
            },
          })) {
            if (!comment.issue) throw new Error("Linear comment has no ticket");
            add(comment, comment.issue.identifier);
          }
      }
      for (const ids of chunks(
        kept.filter((ticket) => !known.has(ticket.uuid)).map((ticket) => ticket.uuid),
        25,
      )) {
        const data = await gql<{ issues: { nodes: { identifier: string; comments: Connection<RawComment> }[] } }>(
          commentsQuery,
          { ids },
        );
        if (data.issues.nodes.length !== ids.length) throw new Error("Linear comments reading is incomplete");
        for (const node of data.issues.nodes)
          for (const comment of await rest(node.identifier, "comments", commentFields, node.comments))
            add(comment, node.identifier);
      }
      signal.throwIfAborted();
      return { startedAt, tickets: kept, comments: [...comments.values()] } satisfies TrackerReading;
    },
  };
}

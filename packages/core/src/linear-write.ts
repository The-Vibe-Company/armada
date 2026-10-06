// Linear write adapter: the only code that changes the tracker. Commands see
// the `LinearWriter` interface, so tests swap in an in-memory fake; this file
// maps it onto Linear's GraphQL API.
import {
  agentLabels,
  type Connection,
  gql,
  type LabelGroups,
  LinearError,
  type LinearRequestOptions,
  type MoreOf,
  normalizeComment,
  type ParentAutoClose,
  parsePullRequestUrl,
  type RawComment,
  readParentAutoClose,
  readRest,
} from "./linear.ts";
import type { Comment, LabelPhase, PullRequest, StatusType } from "./types.ts";

export interface TicketLabel {
  id: string;
  name: string;
  /** Name of the label group it belongs to, if any. */
  group: string | null;
}

export interface WorkflowState {
  id: string;
  name: string;
  type: StatusType;
  position: number;
}

/** A ticket as the write commands need it: labels with ids, the team workflow and every comment. */
export interface Ticket {
  /** Human identifier, e.g. ABC-12. */
  id: string;
  uuid: string;
  title: string;
  url: string;
  /** Branch name Linear suggests for the ticket. */
  branchName: string | null;
  statusType: StatusType;
  stateId: string;
  teamId: string;
  /** Fresh ancestry used for post-close spec completion. */
  parentId: string | null;
  assigneeId: string | null;
  labels: TicketLabel[];
  agentPhase: LabelPhase | null;
  agentRuntime: string | null;
  /** Workflow states of the ticket's team. */
  states: WorkflowState[];
  /** Newest first. */
  comments: Comment[];
  /** Pull requests linked from attachments or the description. */
  prs: PullRequest[];
  /** True when some comments could not be read: an older claim may be missing. */
  commentsTruncated: boolean;
  /** True when some labels could not be read: an agent label may be missing. */
  labelsTruncated: boolean;
  /** Reads cut short by a cap. */
  warnings: string[];
}

export interface IssueCreate {
  teamId: string;
  parentId: string;
  title: string;
  description: string;
}

export interface CreatedIssue {
  uuid: string;
  id: string;
  url: string;
}

export interface TicketChange {
  title?: string;
  stateId?: string;
  assigneeId?: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface LinearWriter {
  /** The user the API key belongs to. */
  viewer(): Promise<{ id: string; name: string }>;
  readTicket(id: string): Promise<Ticket | null>;
  parentAutoClose(id: string): Promise<ParentAutoClose>;
  /** Every direct child, including archived issues; incomplete reads throw. */
  readChildren(uuids: string[]): Promise<SpecChild[]>;
  /** Labels of a group that a ticket of `teamId` may carry (team labels first, then workspace labels). */
  groupLabels(group: string, teamId: string): Promise<TicketLabel[]>;
  /** A label the ticket's team may carry; its team label wins over a workspace label. */
  labelByName(name: string, teamId: string): Promise<TicketLabel | null>;
  createIssue(input: IssueCreate): Promise<CreatedIssue>;
  /** One update: title, state, assignee and label changes are applied together. */
  updateTicket(uuid: string, change: TicketChange): Promise<void>;
  comment(uuid: string, body: string): Promise<{ id: string }>;
  deleteComment(id: string): Promise<void>;
  linkUrl(uuid: string, url: string, title: string): Promise<void>;
}

export interface SpecChild {
  id: string;
  uuid: string;
  title: string;
  url: string;
  statusType: StatusType;
}

interface RawSpecChild {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { type: StatusType };
}

// ------------------------------------------------------------------ GraphQL

const LABEL = "id name parent { name }";
const ATTACHMENT = "title url";
const COMMENT = "id createdAt body user { name }";
const PAGE = "pageInfo { hasNextPage endCursor }";

// Labels, attachments and comments are read to the end with `readRest`, whose
// follow-up pages use Linear's default order: the first page must use it too.
const TICKET_QUERY = /* GraphQL */ `
  query Ticket($id: String!) {
    issue(id: $id) {
      id identifier title url branchName description
      state { id type }
      parent { identifier }
      team { id states(first: 50) { nodes { id name type position } } }
      assignee { id }
      labels(first: 50) { ${PAGE} nodes { ${LABEL} } }
      attachments(first: 50) { ${PAGE} nodes { ${ATTACHMENT} } }
      comments(first: 100) { ${PAGE} nodes { ${COMMENT} } }
    }
  }`;
const MORE_LABELS: MoreOf = { field: "labels", nodes: LABEL, operation: "MoreTicketLabels", what: "labels" };
const MORE_ATTACHMENTS: MoreOf = {
  field: "attachments",
  nodes: ATTACHMENT,
  operation: "MoreTicketAttachments",
  what: "attachments",
};
const MORE_COMMENTS: MoreOf = { field: "comments", nodes: COMMENT, operation: "MoreTicketComments", what: "comments" };

const GROUP_LABELS_QUERY = /* GraphQL */ `
  query GroupLabels($group: String!) {
    issueLabels(first: 100, filter: { parent: { name: { eq: $group } } }) { nodes { id name team { id } } }
  }`;

const VIEWER_QUERY = "query Viewer { viewer { id name } }";
const LABEL_BY_NAME_QUERY = /* GraphQL */ `
  query LabelByName($filter: IssueLabelFilter!) {
    issueLabels(first: 100, filter: $filter) {
      nodes { ${LABEL} team { id } }
    }
  }`;
const UPDATE_MUTATION = /* GraphQL */ `
  mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;
const CREATE_MUTATION = /* GraphQL */ `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { id identifier url } }
  }`;
const COMMENT_MUTATION = /* GraphQL */ `
  mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`;
const DELETE_COMMENT_MUTATION = /* GraphQL */ `
  mutation DeleteComment($id: String!) { commentDelete(id: $id) { success } }`;
const LINK_MUTATION = /* GraphQL */ `
  mutation Link($issueId: String!, $url: String!, $title: String) {
    attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
  }`;

interface RawTicket {
  id: string;
  identifier: string;
  title: string;
  url: string;
  branchName: string | null;
  description: string | null;
  state: { id: string; type: string };
  parent?: { identifier: string } | null;
  team: { id: string; states: { nodes: { id: string; name: string; type: string; position: number }[] } };
  assignee: { id: string } | null;
  labels: Connection<{ id: string; name: string; parent: { name: string } | null }>;
  attachments: Connection<{ title: string; url: string }>;
  comments: Connection<RawComment>;
}

/** `warnings` are the reads that stopped part way, from `readRest`. */
export function normalizeTicket(raw: RawTicket, groups: LabelGroups, warnings: string[] = []): Ticket {
  const labels = raw.labels.nodes.map((l) => ({ id: l.id, name: l.name, group: l.parent?.name ?? null }));
  const prs = new Map<string, PullRequest>();
  for (const a of raw.attachments.nodes) {
    const pr = parsePullRequestUrl(a.url, a.title);
    if (pr) prs.set(pr.url, pr);
  }
  for (const m of raw.description?.matchAll(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g) ?? []) {
    const pr = parsePullRequestUrl(m[0]);
    if (pr && !prs.has(pr.url)) prs.set(pr.url, pr);
  }
  return {
    id: raw.identifier,
    uuid: raw.id,
    title: raw.title,
    url: raw.url,
    branchName: raw.branchName || null,
    statusType: raw.state.type as StatusType,
    stateId: raw.state.id,
    teamId: raw.team.id,
    parentId: raw.parent?.identifier ?? null,
    assigneeId: raw.assignee?.id ?? null,
    labels,
    ...agentLabels(labels, groups),
    states: raw.team.states.nodes
      .map((s) => ({ ...s, type: s.type as StatusType }))
      .sort((a, b) => a.position - b.position),
    comments: raw.comments.nodes
      .map((c) => normalizeComment(c, raw.identifier))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    prs: [...prs.values()].sort((a, b) => a.number - b.number),
    commentsTruncated: !!raw.comments.pageInfo?.hasNextPage,
    labelsTruncated: !!raw.labels.pageInfo?.hasNextPage,
    warnings,
  };
}

export interface LinearWriterOptions extends LinearRequestOptions {
  labels: LabelGroups;
}

function ensure(ok: boolean | undefined, what: string) {
  if (!ok) throw new LinearError(`Linear refused to ${what}`);
}

/** Reconcile an ambiguous comment failure before another physical post. */
async function postOnce(opts: LinearWriterOptions, uuid: string, body: string): Promise<{ id: string }> {
  const startedAt = (opts.now ?? (() => new Date()))().getTime();
  let posts = 0;
  const doFetch = opts.fetch ?? fetch;
  const guardedFetch: NonNullable<LinearRequestOptions["fetch"]> = async (url, init) => {
    if (posts++ > 0) {
      const data = await gql<{ issue: { comments: Connection<RawComment> } | null }>(
        { ...opts, retry: true },
        `query RecentComments($id: String!) { issue(id: $id) { comments(first: 100) { ${PAGE} nodes { ${COMMENT} } } } }`,
        { id: uuid },
      );
      if (!data.issue) throw new LinearError("Linear could not check whether the comment was posted");
      const comments = data.issue.comments;
      const warnings: string[] = [];
      await readRest(opts, uuid, MORE_COMMENTS, comments, warnings);
      const matching = comments.nodes.filter((comment) => comment.body === body);
      const existing = matching.find((comment) => Date.parse(comment.createdAt) >= startedAt);
      if (existing) return Response.json({ data: { commentCreate: { success: true, comment: { id: existing.id } } } });
      // An older identical report is not evidence of this post. Fail closed
      // rather than acknowledge stale progress or duplicate a clock-skewed post.
      if (matching.length)
        throw new LinearError("Linear could not confirm this new comment; an older identical one exists");
      if (comments.pageInfo?.hasNextPage || warnings.length)
        throw new LinearError("Linear could not check every comment; try again after it answers");
    }
    init.signal?.throwIfAborted();
    return doFetch(url, init);
  };
  const data = await gql<{ commentCreate: { success: boolean; comment: { id: string } | null } }>(
    { ...opts, fetch: guardedFetch, retry: true },
    COMMENT_MUTATION,
    { input: { issueId: uuid, body } },
  );
  ensure(data.commentCreate?.success && !!data.commentCreate.comment, "post the comment");
  return { id: data.commentCreate.comment?.id ?? "" };
}

export function createLinearWriter(opts: LinearWriterOptions): LinearWriter {
  return {
    parentAutoClose: (id) => readParentAutoClose(opts, id),
    async readChildren(uuids) {
      const children: SpecChild[] = [];
      const cursors = new Set<string>();
      let after: string | null = null;
      for (let page = 0; page < 100; page++) {
        const data: { issues: Connection<RawSpecChild> } = await gql(
          { ...opts, retry: true },
          `query SpecChildren($parents: [ID!]!, $after: String) {
          issues(first: 100, after: $after, includeArchived: true, filter: { parent: { id: { in: $parents } } }) {
            ${PAGE} nodes { id identifier title url state { type } }
          }
        }`,
          { parents: uuids, after },
        );
        children.push(
          ...data.issues.nodes.map((child) => ({
            id: child.identifier,
            uuid: child.id,
            title: child.title,
            url: child.url,
            statusType: child.state.type,
          })),
        );
        const info = data.issues.pageInfo;
        if (!info) throw new LinearError("Linear did not return child pagination");
        if (!info.hasNextPage) return children;
        if (!info.endCursor || cursors.has(info.endCursor))
          throw new LinearError("Linear did not advance child pagination");
        cursors.add(info.endCursor);
        after = info.endCursor;
      }
      throw new LinearError("Linear children exceed the completion read limit");
    },
    async viewer() {
      return (await gql<{ viewer: { id: string; name: string } }>({ ...opts, retry: true }, VIEWER_QUERY, {})).viewer;
    },
    async readTicket(id) {
      const data = await gql<{ issue: RawTicket | null }>({ ...opts, retry: true }, TICKET_QUERY, { id }).catch(
        (err: unknown) => {
          // Linear answers an unknown identifier with an "Entity not found" error.
          if (err instanceof LinearError && /not found/i.test(err.message)) return { issue: null };
          throw err;
        },
      );
      const raw = data.issue;
      if (!raw) return null;
      const warnings: string[] = [];
      await readRest(opts, raw.identifier, MORE_LABELS, raw.labels, warnings);
      await readRest(opts, raw.identifier, MORE_ATTACHMENTS, raw.attachments, warnings);
      await readRest(opts, raw.identifier, MORE_COMMENTS, raw.comments, warnings);
      return normalizeTicket(raw, opts.labels, warnings);
    },
    async groupLabels(group, teamId) {
      const data = await gql<{ issueLabels: { nodes: { id: string; name: string; team: { id: string } | null }[] } }>(
        { ...opts, retry: true },
        GROUP_LABELS_QUERY,
        { group },
      );
      const usable = data.issueLabels.nodes.filter((l) => !l.team || l.team.id === teamId);
      // A team label shadows a workspace label of the same name.
      const byName = new Map<string, TicketLabel>();
      for (const l of [...usable].sort((a, b) => Number(!!b.team) - Number(!!a.team)))
        if (!byName.has(l.name)) byName.set(l.name, { id: l.id, name: l.name, group });
      return [...byName.values()];
    },
    async labelByName(name, teamId) {
      const data = await gql<{
        issueLabels: {
          nodes: { id: string; name: string; parent: { name: string } | null; team: { id: string } | null }[];
        };
      }>({ ...opts, retry: true }, LABEL_BY_NAME_QUERY, {
        filter: { name: { eqIgnoreCase: name }, or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] },
      });
      const usable = data.issueLabels.nodes.filter((l) => !l.team || l.team.id === teamId);
      const label = usable.find((l) => l.team?.id === teamId) ?? usable[0];
      return label ? { id: label.id, name: label.name, group: label.parent?.name ?? null } : null;
    },
    async createIssue(input) {
      const data = await gql<{
        issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null };
      }>({ ...opts, retry: false }, CREATE_MUTATION, { input });
      const created = data.issueCreate?.issue;
      if (!data.issueCreate?.success || !created?.id || !created.identifier || !created.url)
        throw new LinearError("Linear refused to create the issue");
      return { uuid: created.id, id: created.identifier, url: created.url };
    },
    async updateTicket(uuid, change) {
      const input: Record<string, unknown> = {};
      if (change.title !== undefined) input.title = change.title;
      if (change.stateId) input.stateId = change.stateId;
      if (change.assigneeId) input.assigneeId = change.assigneeId;
      if (change.addLabelIds?.length) input.addedLabelIds = change.addLabelIds;
      if (change.removeLabelIds?.length) input.removedLabelIds = change.removeLabelIds;
      if (!Object.keys(input).length) return;
      const data = await gql<{ issueUpdate: { success: boolean } }>({ ...opts, retry: true }, UPDATE_MUTATION, {
        id: uuid,
        input,
      });
      ensure(data.issueUpdate?.success, "update the ticket");
    },
    async comment(uuid, body) {
      return postOnce(opts, uuid, body);
    },
    async deleteComment(id) {
      const data = await gql<{ commentDelete: { success: boolean } }>(
        { ...opts, retry: false },
        DELETE_COMMENT_MUTATION,
        { id },
      );
      ensure(data.commentDelete?.success, "delete the comment");
    },
    async linkUrl(uuid, url, title) {
      const data = await gql<{ attachmentLinkURL: { success: boolean } }>({ ...opts, retry: true }, LINK_MUTATION, {
        issueId: uuid,
        url,
        title,
      });
      ensure(data.attachmentLinkURL?.success, "link the pull request");
    },
  };
}

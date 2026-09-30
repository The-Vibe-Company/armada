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
  parsePullRequestUrl,
  type RawComment,
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

export interface TicketChange {
  stateId?: string;
  assigneeId?: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface LinearWriter {
  /** The user the API key belongs to. */
  viewer(): Promise<{ id: string; name: string }>;
  readTicket(id: string): Promise<Ticket | null>;
  /** Labels of a group that a ticket of `teamId` may carry (team labels first, then workspace labels). */
  groupLabels(group: string, teamId: string): Promise<TicketLabel[]>;
  /** One update: state, assignee and label changes are applied together. */
  updateTicket(uuid: string, change: TicketChange): Promise<void>;
  comment(uuid: string, body: string): Promise<{ id: string }>;
  deleteComment(id: string): Promise<void>;
  linkUrl(uuid: string, url: string, title: string): Promise<void>;
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
const UPDATE_MUTATION = /* GraphQL */ `
  mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;
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

export function createLinearWriter(opts: LinearWriterOptions): LinearWriter {
  return {
    async viewer() {
      return (await gql<{ viewer: { id: string; name: string } }>(opts, VIEWER_QUERY, {})).viewer;
    },
    async readTicket(id) {
      const data = await gql<{ issue: RawTicket | null }>(opts, TICKET_QUERY, { id }).catch((err: unknown) => {
        // Linear answers an unknown identifier with an "Entity not found" error.
        if (err instanceof LinearError && /not found/i.test(err.message)) return { issue: null };
        throw err;
      });
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
        opts,
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
    async updateTicket(uuid, change) {
      const input: Record<string, unknown> = {};
      if (change.stateId) input.stateId = change.stateId;
      if (change.assigneeId) input.assigneeId = change.assigneeId;
      if (change.addLabelIds?.length) input.addedLabelIds = change.addLabelIds;
      if (change.removeLabelIds?.length) input.removedLabelIds = change.removeLabelIds;
      if (!Object.keys(input).length) return;
      const data = await gql<{ issueUpdate: { success: boolean } }>(opts, UPDATE_MUTATION, { id: uuid, input });
      ensure(data.issueUpdate?.success, "update the ticket");
    },
    async comment(uuid, body) {
      const data = await gql<{ commentCreate: { success: boolean; comment: { id: string } | null } }>(
        opts,
        COMMENT_MUTATION,
        { input: { issueId: uuid, body } },
      );
      ensure(data.commentCreate?.success && !!data.commentCreate.comment, "post the comment");
      return { id: data.commentCreate.comment?.id ?? "" };
    },
    async deleteComment(id) {
      const data = await gql<{ commentDelete: { success: boolean } }>(opts, DELETE_COMMENT_MUTATION, { id });
      ensure(data.commentDelete?.success, "delete the comment");
    },
    async linkUrl(uuid, url, title) {
      const data = await gql<{ attachmentLinkURL: { success: boolean } }>(opts, LINK_MUTATION, {
        issueId: uuid,
        url,
        title,
      });
      ensure(data.attachmentLinkURL?.success, "link the pull request");
    },
  };
}

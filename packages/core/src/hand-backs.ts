// PR-scoped immutable hand-backs. Persistence and forge reads live in adapters.

import { createHash } from "node:crypto";
import type { InboxItem, RuntimeHandle, StoredInboxItem } from "./live.ts";
import { Refusal } from "./refusal.ts";

export const HAND_BACK_SCHEMA = "hand-back/v2";
export const HAND_BACK_LIMIT = 100;
export const HAND_BACK_KIND = "hand-back-v2";
export class HandBackRefusal extends Refusal {
  constructor(message: string) {
    super(message, "read the current scoped hand-back with a compatible CLI");
  }
}
export interface HandBackRef {
  schema: typeof HAND_BACK_SCHEMA;
  id: number;
  project: string;
  repository: string;
  ticket: string;
  pr: number;
  headSha: string;
  claimGeneration: string;
}
export interface HandBackRevision extends HandBackRef {
  body: string;
  author: string;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  supersededBy: number | null;
}
export interface HandBackState {
  schema: typeof HAND_BACK_SCHEMA;
  serverRevision: string;
  project: string;
  repository: string;
  ticket: string;
  claimGeneration: string | null;
  complete: boolean;
  items: StoredInboxItem[];
  merges: { receipt: HandBackMerge; keepOpen: boolean; superseded: boolean }[];
}
export interface HandBackDeclaration {
  schema: typeof HAND_BACK_SCHEMA;
  claimGeneration: string;
  /** Compare-and-supersede fence read before this report, null for a first PR. */
  previous: HandBackRef | null;
}
export interface HandBackMerge {
  handBack: HandBackRef;
  mergedHeadSha: string;
  mergeCommit: string;
  /** Existing coordinator forge verifier, not a worker-supplied permission. */
  verifiedMainLineage: { from: string; to: string } | null;
}
export const fullSha = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{40}$/.test(x);
export function claimGeneration(h: RuntimeHandle | null): string | null {
  return h?.releasedAt ? null : claimIdentityGeneration(h);
}
/** Historical identity only: never authorizes a released claim. */
function claimIdentityGeneration(h: RuntimeHandle | null): string | null {
  if (!h || !h.claimedAt || !h.handle) return null;
  return createHash("sha256")
    .update(JSON.stringify([h.project, h.ticket, h.runtime, h.handle, h.claimedAt, h.workerSessionId ?? null]))
    .digest("hex");
}
/** Final cleanup may repair its own released generation; an older partial receipt may not. */
export function handBackReceiptSuperseded(h: RuntimeHandle | null, generation: string, keepOpen: boolean): boolean {
  return claimIdentityGeneration(h) !== generation || (keepOpen && !!h?.releasedAt);
}
export function parseHandBackRef(raw: unknown): HandBackRef {
  if (!raw || typeof raw !== "object") throw new HandBackRefusal("missing hand-back reference");
  const r = raw as HandBackRef;
  if (
    r.schema !== HAND_BACK_SCHEMA ||
    !Number.isSafeInteger(r.id) ||
    r.id < 1 ||
    !r.project ||
    !r.ticket ||
    !/^[\w-]+\/[\w.-]+$/.test(r.repository) ||
    [".", ".."].includes(r.repository.split("/")[1] ?? "") ||
    !Number.isSafeInteger(r.pr) ||
    r.pr < 1 ||
    r.pr > 2147483647 ||
    !fullSha(r.headSha) ||
    !/^[a-f0-9]{64}$/.test(r.claimGeneration)
  )
    throw new HandBackRefusal("invalid hand-back reference");
  return {
    schema: HAND_BACK_SCHEMA,
    id: r.id,
    project: r.project,
    repository: r.repository,
    ticket: r.ticket,
    pr: r.pr,
    headSha: r.headSha,
    claimGeneration: r.claimGeneration,
  };
}
export function sameHandBack(a: HandBackRef, b: HandBackRef): boolean {
  return (
    a.id === b.id &&
    a.project === b.project &&
    a.repository.toLowerCase() === b.repository.toLowerCase() &&
    a.ticket === b.ticket &&
    a.pr === b.pr &&
    a.headSha === b.headSha &&
    a.claimGeneration === b.claimGeneration
  );
}
export function handBackPrUrl(repository: string, url: string | null): number {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/.exec(url ?? "");
  const pr = Number(match?.[2]);
  if (!match || match[1]?.toLowerCase() !== repository.toLowerCase() || !Number.isSafeInteger(pr) || pr > 2147483647)
    throw new HandBackRefusal("hand-back PR is not in the registered repository");
  return pr;
}
export function validateDeclaration(
  repository: string,
  url: string | null,
  head: string | null,
  summary: string,
): number {
  const pr = handBackPrUrl(repository, url);
  if (!fullSha(head)) throw new HandBackRefusal("hand-back needs a full head SHA");
  const match = /^PR #(\d+), head ([a-f0-9]{40}), CI green(?:[;\s]|$)/.exec(summary);
  if (Number(match?.[1]) !== pr || match?.[2] !== head)
    throw new HandBackRefusal("hand-back summary disagrees with its PR and head");
  return pr;
}
export function checkedHandBackState(raw: unknown, project: string, ticket: string): HandBackState {
  const s = raw as HandBackState | null;
  if (
    !s ||
    s.schema !== HAND_BACK_SCHEMA ||
    !fullSha(s.serverRevision) ||
    s.project !== project ||
    s.ticket !== ticket ||
    !s.complete ||
    !Array.isArray(s.items) ||
    s.items.length > HAND_BACK_LIMIT ||
    !Array.isArray(s.merges) ||
    s.merges.length > HAND_BACK_LIMIT ||
    (s.claimGeneration !== null && !/^[a-f0-9]{64}$/.test(s.claimGeneration))
  )
    throw new HandBackRefusal("server has no complete hand-back/v2 state; no report was written");
  for (const item of s.items)
    if (item.handBack) {
      const r = parseHandBackRef(item.handBack);
      if (r.id !== item.id || r.project !== project || r.ticket !== ticket || r.repository !== s.repository)
        throw new HandBackRefusal("hand-back state contains a foreign reference");
    }
  for (const entry of s.merges) {
    const receipt = parseHandBackMerge(entry.receipt);
    if (
      receipt.handBack.project !== project ||
      receipt.handBack.ticket !== ticket ||
      typeof entry.keepOpen !== "boolean" ||
      typeof entry.superseded !== "boolean"
    )
      throw new HandBackRefusal("foreign merge receipt in hand-back state");
  }
  return s;
}
export function currentHandBack(state: HandBackState, pr: number): InboxItem | null {
  const rows = state.items.filter((i) => !i.resolvedAt && i.handBack?.pr === pr);
  if (rows.length > 1) throw new HandBackRefusal("ambiguous current hand-back");
  const row = rows[0] ?? null;
  if (row?.handBack && row.handBack.claimGeneration !== state.claimGeneration)
    throw new HandBackRefusal("hand-back belongs to a superseded claim");
  return row;
}
export function validateHandBackMerge(row: HandBackRef, receipt: HandBackMerge): void {
  const ref = parseHandBackRef(receipt.handBack);
  if (!sameHandBack(row, ref) || !fullSha(receipt.mergedHeadSha) || !fullSha(receipt.mergeCommit))
    throw new HandBackRefusal("merge receipt does not identify this hand-back");
  if (
    row.headSha !== receipt.mergedHeadSha &&
    (receipt.verifiedMainLineage?.from !== row.headSha || receipt.verifiedMainLineage.to !== receipt.mergedHeadSha)
  )
    throw new HandBackRefusal("merged head is not linked to this PR's hand-back");
}

export function parseHandBackDeclaration(raw: unknown): HandBackDeclaration {
  const r = raw as HandBackDeclaration | null;
  if (!r || r.schema !== HAND_BACK_SCHEMA || !/^[a-f0-9]{64}$/.test(r.claimGeneration) || !("previous" in r))
    throw new HandBackRefusal("invalid hand-back declaration");
  return {
    schema: HAND_BACK_SCHEMA,
    claimGeneration: r.claimGeneration,
    previous: r.previous === null ? null : parseHandBackRef(r.previous),
  };
}
export function parseHandBackMerge(raw: unknown): HandBackMerge {
  const r = raw as HandBackMerge | null;
  if (
    !r ||
    !fullSha(r.mergedHeadSha) ||
    !fullSha(r.mergeCommit) ||
    (r.verifiedMainLineage !== null && (!fullSha(r.verifiedMainLineage?.from) || !fullSha(r.verifiedMainLineage?.to)))
  )
    throw new HandBackRefusal("invalid hand-back merge receipt");
  return {
    handBack: parseHandBackRef(r.handBack),
    mergedHeadSha: r.mergedHeadSha,
    mergeCommit: r.mergeCommit,
    verifiedMainLineage:
      r.verifiedMainLineage === null ? null : { from: r.verifiedMainLineage.from, to: r.verifiedMainLineage.to },
  };
}

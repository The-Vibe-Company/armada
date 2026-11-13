import type { AgentEvent, TaskOutcome } from "@armada/core";
import { decryptSecret, type Sql } from "@armada/core/server";
import type { Caller } from "../caller.ts";
import type { OttoScope } from "./observation.ts";
import { type OttoSnapshot, readOttoSnapshot } from "./snapshot.ts";

export interface FleetSandbox {
  id: string;
  owner_id: string;
  access_owner_id: string;
  visibility: "org" | "private";
  provider: "boat" | "modal";
  provider_sandbox_id: string;
  status: string;
  last_observed_at: string | null;
  deleted_at: string | null;
  task_prompt_id: string | null;
  task_outcome: TaskOutcome | null;
  resource_project: { url: string; branch: string } | null;
  modal_workspace: string | null;
  modal_environment: string | null;
  modal_app_id: string | null;
  branch: string | null;
  branchComplete: boolean;
  reportedHeads: { number: number; sha: string }[];
  runningWindows: { start: number; end: number | null; branch: string | null }[];
  activity: "live" | "idle" | "not_live" | "unknown";
  activityAt: string | null;
  activityObservedAt: string | null;
}
export const fresh = (at: string | null | undefined, now: Date) =>
  !!at && now.getTime() >= new Date(at).getTime() && now.getTime() - new Date(at).getTime() < 600_000;
export const issueFromBranch = (branch: string | null | undefined) => {
  const match = /^codex\/([1-9]\d*)-/.exec(branch ?? "");
  return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
};
export function repositoryOf(url: string | undefined) {
  return (
    url
      ?.replace(/^git@github.com:/, "https://github.com/")
      .replace(/\.git$/, "")
      .replace(/^https:\/\/github.com\//, "") ?? null
  );
}
/** Reads existing journals only; never resumes, executes, prompts or contacts a provider. */
export async function readFleet(
  sql: Sql,
  scope: OttoScope,
  caller: Caller,
  now: Date,
  key?: string,
  supplied?: OttoSnapshot,
) {
  const snapshot = supplied ?? (await readOttoSnapshot(sql, scope, caller, now.toISOString().slice(0, 10), key));
  const rows = snapshot.fleet;
  const restricted = snapshot.restricted || snapshot.capped;
  for (const s of rows) {
    if (s.last_observed_at) s.last_observed_at = new Date(s.last_observed_at).toISOString();
    let events: AgentEvent[] = [];
    if (s.provider === "modal" && s.modal_workspace && s.modal_environment && s.modal_app_id) {
      const stored = s.modal_events.map((event) => ({ event }));
      events = stored.some((r) => r.event === null) ? [] : stored.flatMap((r) => (r.event ? [r.event] : []));
    } else if (s.provider === "boat" && key) {
      const encrypted = s.runtime_events.map((hex) => ({ event_enc: hex === null ? null : Buffer.from(hex, "hex") }));
      let bytes = 0;
      for (const row of encrypted) {
        bytes += row.event_enc?.byteLength ?? 1048577;
        if (!row.event_enc || bytes > 1048576) {
          events = [];
          break;
        }
        try {
          const event = JSON.parse(await decryptSecret(new Uint8Array(row.event_enc), key)) as AgentEvent;
          if (event.kind === "prompt" || event.kind === "message") events.push(event);
        } catch {
          events = [];
          break;
        } // Corrupt/missing evidence is not idle.
      }
    }
    s.reportedHeads = [];
    const seenMessages = new Set<string>();
    for (const event of events) {
      if (event.kind !== "message") continue;
      const identity = JSON.stringify([event.promptId, event.messageId ?? event.id]);
      if (seenMessages.has(identity)) continue;
      seenMessages.add(identity);
      if (
        event.kind !== "message" ||
        event.partial ||
        event.textMode === "delta" ||
        event.retracted ||
        event.parentToolUseId ||
        event.responseKind === "tool_result"
      )
        continue;
      if (!/^READY TO MERGE: PR #[1-9]\d* head [a-f0-9]{40}(?:\s|$)/i.test(event.text.trimStart())) continue;
      for (const match of event.text.matchAll(/^READY TO MERGE: PR #([1-9]\d*) head ([a-f0-9]{40})\s*$/gim)) {
        if (Number.isSafeInteger(Number(match[1])) && match[2])
          s.reportedHeads.push({ number: Number(match[1]), sha: match[2] });
      }
    }
    const prompts = events.filter(
      (e): e is Extract<AgentEvent, { kind: "prompt" }> => e.kind === "prompt" && Number.isFinite(e.at),
    );
    s.runningWindows = [];
    const open = new Map<string, { start: number; branch: string | null }>();
    for (const event of [...prompts].reverse()) {
      if (!event.promptId) continue;
      if (event.status === "running" && !open.has(event.promptId)) {
        const refs = [...new Set(event.text.match(/\bcodex\/[1-9]\d*-[A-Za-z0-9._/-]+/g) ?? [])];
        open.set(event.promptId, {
          start: event.at,
          branch: refs.length === 1 ? (refs[0] ?? null) : refs.length > 1 ? null : (s.resource_project?.branch ?? null),
        });
      } else if (["finished", "failed", "interrupted"].includes(event.status)) {
        const start = open.get(event.promptId);
        if (start !== undefined) s.runningWindows.push({ ...start, end: event.at });
        open.delete(event.promptId);
      }
    }
    for (const start of open.values()) s.runningWindows.push({ ...start, end: null });
    const last = prompts[0];
    const branches = new Set(last?.text.match(/\bcodex\/[1-9]\d*-[A-Za-z0-9._/-]+/g) ?? []);
    s.branch =
      branches.size === 1
        ? ([...branches][0] ?? null)
        : branches.size > 1
          ? null
          : (s.resource_project?.branch ?? null);
    s.branchComplete = !!s.branch && branches.size <= 1;
    s.activityAt = last ? new Date(last.at).toISOString() : s.last_observed_at;
    const observed = fresh(s.last_observed_at, now) && (!last || last.at <= now.getTime());
    s.activity =
      s.deleted_at || ["stopped", "failed", "deleted"].includes(s.status)
        ? "not_live"
        : !observed
          ? "unknown"
          : ["running", "ready"].includes(s.status) && last?.status === "running"
            ? "live"
            : ["running", "ready"].includes(s.status) &&
                ["finished", "failed", "interrupted"].includes(last?.status ?? "")
              ? "idle"
              : "unknown";
    s.activityObservedAt = s.activity === "not_live" ? now.toISOString() : s.last_observed_at;
  }
  return { sandboxes: rows, restricted, capped: snapshot.capped, observedAt: now.toISOString() };
}

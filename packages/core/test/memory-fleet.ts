import { sinceSummary } from "../src/catchup.ts";
// The fleet's live data in memory, for tests: the same results as the app's
// Postgres store (`packages/dashboard/lib/fleet-store.ts`, tested on PGlite),
// with its unique rules (one open plan, hand-back and launch request per
// ticket, one open answer per question) and its atomic lease.
import type {
  CoordinatorPresence,
  EventInput,
  FleetStore,
  InboxItem,
  Lease,
  PendingLaunch,
  ProjectRecord,
  Reservation,
  RuntimeHandle,
  SessionRecord,
  StoredInboxItem,
  WorkerProfile,
} from "../src/live.ts";
import { FOLLOW_EVENT_KINDS, unusedLaunchExpired } from "../src/live.ts";
import { OBSERVABLE_RUNTIMES, runtimeNameOf } from "../src/runtime.ts";
import type { Validation } from "../src/validations.ts";

interface EventRow extends Omit<EventInput, "at"> {
  id: number;
  at: string;
}

interface HandleRow extends Omit<RuntimeHandle, "profile"> {}

interface ItemRow extends Omit<StoredInboxItem, "request"> {
  requestPr?: number | null;
  requestDeferred?: boolean;
  requestQuestion: number | null;
  requestProfile: string | null;
  requestValidation?: number | null;
}

/** A launch as the app keeps it (`armada_worker`), with only what the fleet reads of it. */
export interface LaunchRow extends PendingLaunch {
  project: string;
  endedAt: string | null;
}

const REQUEST_KINDS = ["answer-request", "launch-request", "merge-request", "release-request", "plan-changes"];
const key = (project: string, ticket: string) => `${project}\n${ticket}`;

export function memoryFleet(): FleetStore & {
  events: EventRow[];
  items: ItemRow[];
  leases: Map<string, Lease>;
  presence: Map<string, { handle: string | null; cliVersion: string | null; at: string }>;
  /** Launches, as the app's `createLaunch` and `exchangeLaunch` write them: tests push and edit them. */
  launches: LaunchRow[];
  validations: Validation[];
} {
  const projects = new Map<string, ProjectRecord>();
  const events: EventRow[] = [];
  const handles = new Map<string, HandleRow>();
  const paths = new Map<string, string[]>();
  const profiles = new Map<string, WorkerProfile>();
  const items: ItemRow[] = [];
  const leases = new Map<string, Lease>();
  const presence = new Map<string, { handle: string | null; cliVersion: string | null; at: string }>();
  const coordinators = new Map<string, CoordinatorPresence>();
  const sessions: SessionRecord[] = [];
  const launches: LaunchRow[] = [];
  const validations: Validation[] = [];
  const heldResources: Reservation[] = [];
  const copy = (v: Validation): Validation => structuredClone(v);
  const endReservations = (project: string, ticket: string, at: Date, merged: boolean) => {
    for (const r of heldResources)
      if (r.project === project && r.ticket === ticket && !r.endedAt) {
        r.endedAt = at.toISOString();
        r.merged = merged;
      }
  };

  const stored = (r: ItemRow): StoredInboxItem => {
    const { requestQuestion, requestProfile, requestPr, requestValidation, requestDeferred, ...rest } = r;
    return {
      ...rest,
      ...(r.kind === "decision"
        ? { request: { question: null, profile: null, validation: requestValidation ?? null } }
        : {}),
      ...(REQUEST_KINDS.includes(r.kind)
        ? {
            request: {
              question: requestQuestion,
              profile: requestProfile,
              ...(requestDeferred ? { deferred: true } : {}),
              ...(requestPr == null ? {} : { pr: requestPr }),
            },
          }
        : {}),
    };
  };
  const item = (r: ItemRow): InboxItem => {
    const { resolvedAt: _a, resolution: _b, ...rest } = stored(r);
    return rest;
  };
  const handleOf = (h: HandleRow): RuntimeHandle => {
    const lastAnsweredAt = items
      .filter(
        (i) =>
          i.project === h.project &&
          i.ticket === h.ticket &&
          ["question", "plan", "decision"].includes(i.kind) &&
          i.resolvedAt &&
          i.resolvedAt >= h.claimedAt,
      )
      .map((i) => i.resolvedAt)
      .sort()
      .at(-1);
    return {
      ...h,
      profile: profiles.get(key(h.project, h.ticket))?.name ?? null,
      ...(lastAnsweredAt ? { lastAnsweredAt } : {}),
    };
  };
  const insert = (r: Omit<ItemRow, "id" | "resolvedAt" | "resolution">) => {
    const id = items.length + 1;
    items.push({ ...r, id, resolvedAt: null, resolution: null });
    return id;
  };
  const open = (project: string, ticket: string | null, kind: string) =>
    items.find((i) => i.project === project && i.ticket === ticket && i.kind === kind && !i.resolvedAt);
  const resolve = (rows: ItemRow[], resolution: string, at: Date) => {
    for (const r of rows) Object.assign(r, { resolvedAt: at.toISOString(), resolution });
    return rows.length;
  };

  return {
    async digestRecords(project, since, now) {
      const start = since ?? new Date(now.getTime() - 4 * 60 * 60_000).toISOString();
      const rows = events.filter((e) => e.project === project && e.at >= start && e.at <= now.toISOString());
      return {
        language: "en",
        input: {
          since: start,
          until: now.toISOString(),
          now,
          inFlight: [],
          phaseMedians: {},
          summary: sinceSummary({
            since: start,
            now,
            records: [
              {
                project,
                silentAfterMinutes: 15,
                merged: rows.filter((e) => e.kind === "merge").map((e) => ({ ticket: e.ticket ?? "", at: e.at })),
                claimed: [],
                blocked: [],
                gaps: [],
                waiting: validations
                  .filter((v) => v.project === project && !v.decision)
                  .map((v) => ({ id: v.id, ticket: v.ticket, kind: v.kind })),
              },
            ],
          }),
        },
      };
    },
    events,
    items,
    leases,
    presence,
    launches,
    validations,

    async reserve(input) {
      const held = heldResources.filter(
        (r) => r.project === input.project && r.key === input.key && (!r.endedAt || r.merged),
      );
      const value = input.next
        ? (
            held.reduce(
              (max, r) => (/^[+-]?[0-9]+$/.test(r.value) && BigInt(r.value) > max ? BigInt(r.value) : max),
              BigInt(input.floor ?? 0),
            ) + 1n
          ).toString()
        : (input.value ?? "");
      const holder = held.find((r) => r.value === value);
      if (holder) return { reserved: false, holder: structuredClone(holder) };
      const reservation: Reservation = {
        id: heldResources.length + 1,
        project: input.project,
        key: input.key,
        value,
        ticket: input.ticket,
        note: input.note ?? null,
        reservedAt: input.at.toISOString(),
        endedAt: null,
        merged: false,
      };
      heldResources.push(reservation);
      return { reserved: true, reservation: structuredClone(reservation) };
    },
    async reservations(project) {
      return structuredClone(heldResources.filter((r) => r.project === project && (!r.endedAt || r.merged)));
    },
    async unreserve(input) {
      const rows = heldResources.filter(
        (r) =>
          r.project === input.project && r.ticket === input.ticket && r.key === input.key && !r.endedAt && !r.merged,
      );
      for (const r of rows) r.endedAt = input.at.toISOString();
      return rows.length;
    },
    async ensureProject(p, at) {
      if (projects.has(p.slug)) return;
      const t = at.toISOString();
      projects.set(p.slug, { ...p, organization: null, createdAt: t, updatedAt: t });
    },
    async upsertProject(p, at) {
      const was = projects.get(p.slug);
      if (!was) return this.ensureProject(p, at);
      if (
        was.name !== p.name ||
        was.repository !== p.repository ||
        was.programRoot !== p.programRoot ||
        (!was.owner && p.owner)
      )
        projects.set(p.slug, { ...was, ...p, owner: was.owner ?? p.owner ?? null, updatedAt: at.toISOString() });
    },
    async listProjects() {
      return [...projects.values()].sort((a, b) => a.slug.localeCompare(b.slug));
    },

    async saveTicketPaths(project, ticket, declared) {
      paths.set(key(project, ticket), [...declared]);
    },
    async ticketPaths(project) {
      return Object.fromEntries(
        [...paths].filter(([k]) => k.startsWith(`${project}\n`)).map(([k, v]) => [k.slice(project.length + 1), [...v]]),
      );
    },
    async deleteTicketPaths(project, ticket, guard) {
      const h = handles.get(key(project, ticket));
      if (guard?.absent && h) return;
      if (
        guard &&
        !guard.absent &&
        (!h ||
          (guard.handle && h.handle !== guard.handle) ||
          (guard.claimedAt && h.claimedAt !== new Date(guard.claimedAt).toISOString()) ||
          (guard.workerSessionId && h.workerSessionId && h.workerSessionId !== guard.workerSessionId))
      )
        return;
      paths.delete(key(project, ticket));
    },
    async recordEvent(e) {
      events.push({ ...e, id: events.length + 1, at: e.at.toISOString() });
      if (e.kind === "report") {
        const session = sessions.find(
          (session) => session.project === e.project && session.ticket === e.ticket && !session.releasedAt,
        );
        if (session && (!session.lastReport || session.lastReport.at <= e.at.toISOString()))
          session.lastReport = {
            at: e.at.toISOString(),
            message: e.message ?? null,
            phase: e.phase ?? null,
            shippingStage: e.shippingStage ?? null,
          };
      }
    },
    async lastEventTimes(project) {
      const out: Record<string, string> = {};
      for (const e of events)
        if (
          e.kind !== "heartbeat" &&
          e.project === project &&
          e.ticket &&
          (!out[e.ticket] || e.at > (out[e.ticket] ?? ""))
        )
          out[e.ticket] = e.at;
      return out;
    },
    async eventsSince(project, q) {
      const boundary = (e: EventRow, at: string, id: number) => e.at > at || (e.at === at && e.id > id);
      const floor = new Date(Date.parse(q.afterAt) - 120_000).toISOString();
      const recent = events
        .filter(
          (e) =>
            e.project === project &&
            q.kinds.includes(e.kind as never) &&
            (!q.handoverOnly || e.kind !== "report" || e.phase === "ready-to-merge") &&
            (!q.tickets || q.tickets.includes(e.ticket)) &&
            e.at >= floor &&
            !boundary(e, q.afterAt, q.afterId),
        )
        .sort((a, b) => b.id - a.id)
        .slice(0, 500)
        .map((e) => e.id);
      return events
        .filter(
          (e) =>
            e.project === project &&
            FOLLOW_EVENT_KINDS.includes(e.kind as never) &&
            q.kinds.includes(e.kind as never) &&
            (!q.handoverOnly || e.kind !== "report" || e.phase === "ready-to-merge") &&
            (!q.tickets || q.tickets.includes(e.ticket)) &&
            e.at >= floor &&
            (boundary(e, q.afterAt, q.afterId) || (q.seenIds && recent.includes(e.id) && !q.seenIds.includes(e.id))) &&
            (!q.pageAfter || boundary(e, q.pageAfter.at, q.pageAfter.id)),
        )
        .sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id)
        .slice(0, q.limit ?? 200)
        .map((e) => ({
          id: e.id,
          ticket: e.ticket,
          kind: e.kind as "claim",
          phase: e.phase ?? null,
          shippingStage: e.shippingStage ?? null,
          message: e.message ?? null,
          runtime: e.runtime ?? null,
          handle: e.handle ?? null,
          prUrl: e.prUrl ?? null,
          headSha: e.headSha ?? null,
          at: e.at,
        }));
    },
    async latestEvents(project, opts = {}) {
      const since = opts.since?.toISOString() ?? "";
      const out: Record<string, EventRow> = {};
      for (const e of events) {
        if (
          e.kind === "heartbeat" ||
          e.project !== project ||
          !e.ticket ||
          e.at < since ||
          (opts.tickets && !opts.tickets.includes(e.ticket))
        )
          continue;
        const was = out[e.ticket];
        if (!was || e.at > was.at || (e.at === was.at && e.id > was.id)) out[e.ticket] = e;
      }
      return Object.fromEntries(
        Object.entries(out).map(([t, e]) => [
          t,
          {
            kind: e.kind,
            phase: e.phase ?? null,
            shippingStage: e.shippingStage ?? null,
            message: e.message ?? null,
            runtime: e.runtime ?? null,
            handle: e.handle ?? null,
            prUrl: e.prUrl ?? null,
            at: e.at,
          },
        ]),
      );
    },
    async recordCoordinatorSeen(seen) {
      const was = presence.get(seen.project);
      const at = seen.at.toISOString();
      if (!was || was.at <= at)
        presence.set(seen.project, {
          handle: seen.facts?.handle ?? seen.handle ?? null,
          cliVersion: seen.cliVersion ?? seen.facts?.cliVersion ?? was?.cliVersion ?? null,
          at,
        });
      if (was && was.at > at) return;
      const previous = coordinators.get(seen.project);
      coordinators.set(seen.project, {
        harness: seen.facts?.harness ?? previous?.harness ?? null,
        handle: seen.facts ? seen.facts.handle : (seen.handle ?? previous?.handle ?? null),
        model: seen.facts ? seen.facts.model : (previous?.model ?? null),
        cliVersion: seen.cliVersion ?? seen.facts?.cliVersion ?? previous?.cliVersion ?? null,
        startedAt: previous && seen.at.getTime() - Date.parse(previous.seenAt) < 30 * 60_000 ? previous.startedAt : at,
        seenAt: at,
        inboxSeenAt: seen.inboxRead === false ? (previous?.inboxSeenAt ?? null) : at,
      });
      if (seen.inboxRead !== false)
        await this.recordEvent({
          project: seen.project,
          ticket: "",
          kind: "inbox",
          handle: seen.facts?.handle ?? seen.handle ?? null,
          at: seen.at,
        });
    },
    async lastCoordinatorSeen(project) {
      return presence.get(project)?.at ?? null;
    },
    async getCoordinatorPresence(project) {
      return coordinators.get(project) ?? null;
    },
    async inboxReads(project, now) {
      return events
        .filter(
          (event) =>
            event.project === project &&
            event.kind === "inbox" &&
            Date.parse(event.at) >= now.getTime() - 7 * 24 * 60 * 60_000 &&
            Date.parse(event.at) <= now.getTime(),
        )
        .map((event) => ({ id: event.id, at: event.at, handle: event.handle ?? null }));
    },
    async listSessions(project, opts) {
      return sessions
        .filter(
          (session) =>
            session.project === project && (!session.releasedAt || session.releasedAt >= opts.since.toISOString()),
        )
        .map((session) => ({ ...session }));
    },

    async saveWorkerProfile(w) {
      const session = sessions.find(
        (session) => session.project === w.project && session.ticket === w.ticket && !session.releasedAt,
      );
      if (session)
        Object.assign(session, {
          profile: w.profile?.name ?? null,
          agent: w.profile?.agent ?? null,
          model: w.profile?.model ?? null,
          effort: w.profile?.effort ?? null,
        });
      if (w.profile) profiles.set(key(w.project, w.ticket), w.profile);
      else profiles.delete(key(w.project, w.ticket));
    },
    async getWorkerProfile(project, ticket) {
      return profiles.get(key(project, ticket)) ?? null;
    },
    async saveRuntimeHandle(h) {
      const was = handles.get(key(h.project, h.ticket));
      const same =
        was &&
        was.handle === h.handle &&
        !was.releasedAt &&
        (was.workerSessionId ?? null) === (h.workerSessionId ?? null);
      if (!same) {
        const previous = sessions.find(
          (session) => session.project === h.project && session.ticket === h.ticket && !session.releasedAt,
        );
        if (previous) previous.releasedAt = h.at.toISOString();
        sessions.push({
          project: h.project,
          ticket: h.ticket,
          runtime: h.runtime,
          handle: h.handle,
          branch: h.branch,
          claimedAt: h.at.toISOString(),
          releasedAt: null,
          profile: null,
          agent: null,
          model: null,
          effort: null,
          lastReport: null,
        });
      }
      handles.set(key(h.project, h.ticket), {
        project: h.project,
        ticket: h.ticket,
        runtime: h.runtime,
        handle: h.handle,
        branch: h.branch,
        claimedAt: same ? was.claimedAt : h.at.toISOString(),
        releasedAt: null,
        lastHeartbeatAt: same && was.workerSessionId === h.workerSessionId ? was.lastHeartbeatAt : null,
        workerSessionId: h.workerSessionId,
        runtimeState: same ? was.runtimeState : null,
      });
    },
    async observeRuntime(input) {
      const h = handles.get(key(input.project, input.ticket));
      if (
        !h ||
        !OBSERVABLE_RUNTIMES.includes(runtimeNameOf(h.runtime) as "herdr" | "conductor") ||
        (h.releasedAt && input.state !== "gone") ||
        h.handle !== input.handle ||
        h.claimedAt !== input.claimedAt ||
        (h.runtimeState && h.runtimeState.at > input.at.toISOString())
      )
        return false;
      const sequence = input.sequence ?? h.runtimeState?.sequence;
      const sameTransition =
        h.runtimeState?.state === input.state &&
        (input.sequence === undefined || input.sequence === h.runtimeState?.sequence);
      h.runtimeState = {
        ...(sequence === undefined ? {} : { sequence }),
        state: input.state,
        at: input.at.toISOString(),
        since:
          input.since ??
          (sameTransition
            ? (h.runtimeState?.since ?? h.runtimeState?.at ?? input.at.toISOString())
            : input.at.toISOString()),
      };
      return true;
    },
    async stopRuntime(input) {
      const h = handles.get(key(input.project, input.ticket));
      if (
        !h ||
        !OBSERVABLE_RUNTIMES.includes(runtimeNameOf(h.runtime) as "herdr" | "conductor") ||
        h.handle !== input.handle ||
        h.claimedAt !== input.claimedAt
      )
        return false;
      if (!h.releasedAt) {
        await this.releaseRuntimeHandle(input.project, input.ticket, input.at);
        await this.recordEvent({
          project: input.project,
          ticket: input.ticket,
          kind: "release",
          phase: "released",
          runtime: h.runtime,
          handle: h.handle,
          message: "Runtime workspace archived",
          at: input.at,
        });
      }
      return true;
    },
    async heartbeatTimes(project) {
      return Object.fromEntries(
        [...handles.values()]
          .filter((handle) => handle.project === project && !handle.releasedAt && handle.lastHeartbeatAt)
          .map((handle) => [handle.ticket, handle.lastHeartbeatAt as string]),
      );
    },
    async recordHeartbeat(input) {
      const handle = handles.get(key(input.project, input.ticket));
      if (
        !handle ||
        handle.releasedAt ||
        handle.handle !== input.handle ||
        (input.claimedAt && input.claimedAt !== handle.claimedAt) ||
        (handle.workerSessionId ?? null) !== (input.workerSessionId ?? null)
      )
        return { active: false, claimedAt: null };
      handle.lastHeartbeatAt = input.at.toISOString();
      const session = sessions.find(
        (session) =>
          session.project === input.project &&
          session.ticket === input.ticket &&
          session.handle === input.handle &&
          session.claimedAt === handle.claimedAt &&
          !session.releasedAt,
      );
      if (session) session.lastHeartbeatAt = handle.lastHeartbeatAt;
      await this.recordEvent({
        project: input.project,
        ticket: input.ticket,
        handle: input.handle,
        kind: "heartbeat",
        at: input.at,
      });
      return { active: true, claimedAt: handle.claimedAt };
    },
    async releaseRuntimeHandle(project, ticket, at, guard, merged = false) {
      const h = handles.get(key(project, ticket));
      if (guard?.absent) {
        if (h) return false;
        endReservations(project, ticket, at, merged);
        return true;
      }
      const guarded = !!(guard?.handle || guard?.claimedAt || guard?.workerSessionId);
      if (guarded && !h) {
        if (guard?.claimedAt) return false;
        endReservations(project, ticket, at, merged);
        return true;
      }
      if (
        guarded &&
        h &&
        ((guard?.handle && h.handle !== guard.handle) ||
          (guard?.claimedAt && h.claimedAt !== new Date(guard.claimedAt).toISOString()) ||
          (guard?.workerSessionId && h.workerSessionId && h.workerSessionId !== guard.workerSessionId))
      )
        return false;
      for (const session of sessions)
        if (
          session.project === project &&
          session.ticket === ticket &&
          !session.releasedAt &&
          (!guarded ||
            (h
              ? session.handle === h.handle && session.claimedAt === h.claimedAt
              : !guard?.handle || session.handle === guard.handle))
        )
          session.releasedAt = at.toISOString();
      if (h && !h.releasedAt) h.releasedAt = at.toISOString();
      profiles.delete(key(project, ticket));
      endReservations(project, ticket, at, merged);
      return true;
    },
    async openRuntimeHandles(project) {
      return [...handles.values()]
        .filter((h) => h.project === project && !h.releasedAt)
        .sort((a, b) => a.ticket.localeCompare(b.ticket))
        .map(handleOf);
    },
    async getRuntimeHandle(project, ticket) {
      const h = handles.get(key(project, ticket));
      return h ? handleOf(h) : null;
    },

    async addInboxItem(i) {
      return insert({
        project: i.project,
        ticket: i.ticket,
        kind: i.kind,
        recipient: i.recipient,
        author: i.author,
        body: i.body,
        createdAt: i.at.toISOString(),
        requestQuestion: null,
        requestProfile: null,
      });
    },
    async addRequest(r) {
      if (
        r.kind === "merge-request" &&
        items.some(
          (item) => item.project === r.project && item.kind === r.kind && item.requestPr === r.pr && !item.resolvedAt,
        )
      )
        return null;
      if (r.kind === "answer-request" || r.kind === "plan-changes") {
        const q = items.find((i) => i.project === r.project && i.id === r.question);
        if (!q || !["question", "plan"].includes(q.kind) || q.recipient !== "coordinator" || q.resolvedAt) return null;
        if (r.kind === "plan-changes" && q.kind !== "plan") return null;
        if (
          items.some(
            (i) => i.project === r.project && i.kind === r.kind && i.requestQuestion === r.question && !i.resolvedAt,
          )
        )
          return null;
      } else if (r.kind !== "merge-request" && open(r.project, r.ticket, r.kind)) return null;
      return insert({
        project: r.project,
        ticket: r.ticket,
        kind: r.kind,
        recipient: "coordinator",
        author: r.author,
        body: r.body,
        createdAt: r.at.toISOString(),
        requestQuestion: r.question,
        requestDeferred: r.deferred,
        requestProfile: r.profile,
        requestPr: r.pr,
      });
    },
    async putPlan(i) {
      const was = open(i.project, i.ticket, "plan");
      if (was) Object.assign(was, { body: i.body, author: i.author, createdAt: i.at.toISOString() });
      else await this.addInboxItem({ ...i, kind: "plan", recipient: "coordinator" });
    },
    async putHandBack(i) {
      const was = open(i.project, i.ticket, "hand-back");
      if (was) Object.assign(was, { body: i.body, author: i.author, createdAt: i.at.toISOString() });
      else await this.addInboxItem({ ...i, kind: "hand-back", recipient: "coordinator" });
    },
    async openInboxItems(q) {
      return items
        .filter(
          (i) =>
            i.project === q.project &&
            i.recipient === q.recipient &&
            !i.resolvedAt &&
            (!q.ticket || i.ticket === q.ticket),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
        .map(item);
    },
    async getInboxItem(project, id) {
      const r = items.find((i) => i.project === project && i.id === id);
      return r ? stored(r) : null;
    },
    async resolveInboxItem(q) {
      return (
        resolve(
          items.filter((i) => i.project === q.project && i.id === q.id && !i.resolvedAt),
          q.resolution,
          q.at,
        ) > 0
      );
    },
    async lastAnsweredAt(project, opts = {}) {
      const since = opts.since?.toISOString() ?? "";
      const out: Record<string, string> = {};
      for (const i of items)
        if (
          i.project === project &&
          ["question", "plan", "decision"].includes(i.kind) &&
          i.ticket &&
          i.resolvedAt &&
          i.resolvedAt >= since &&
          (!opts.tickets || opts.tickets.includes(i.ticket))
        )
          if (!out[i.ticket] || i.resolvedAt > (out[i.ticket] ?? "")) out[i.ticket] = i.resolvedAt;
      return out;
    },
    async resolveInboxItems(q) {
      return resolve(
        items.filter((i) => i.project === q.project && i.ticket === q.ticket && i.kind === q.kind && !i.resolvedAt),
        q.resolution,
        q.at,
      );
    },
    async resolveAnswerRequests(q) {
      return resolve(
        items.filter(
          (i) =>
            i.project === q.project && i.kind === "answer-request" && !i.resolvedAt && i.requestQuestion === q.question,
        ),
        q.resolution,
        q.at,
      );
    },
    async resolvePlans(q) {
      const plans = items.filter(
        (i) => i.project === q.project && i.ticket === q.ticket && i.kind === "plan" && !i.resolvedAt,
      );
      const ids = new Set(plans.map((p) => p.id));
      resolve(
        items.filter(
          (i) =>
            i.project === q.project &&
            i.kind === "answer-request" &&
            !i.resolvedAt &&
            i.requestQuestion !== null &&
            ids.has(i.requestQuestion),
        ),
        q.resolution,
        q.at,
      );
      return resolve(plans, q.resolution, q.at);
    },

    async acquireLease(l) {
      const k = key(l.project, l.name);
      const held = leases.get(k);
      if (held && held.holder !== l.holder && Date.parse(held.expiresAt) > l.at.getTime())
        return { acquired: false, held: { ...held } };
      leases.set(k, {
        project: l.project,
        name: l.name,
        holder: l.holder,
        acquiredAt: held?.holder === l.holder ? held.acquiredAt : l.at.toISOString(),
        expiresAt: new Date(l.at.getTime() + l.ttlMs).toISOString(),
      });
      return { acquired: true };
    },
    async getLease(project, name) {
      const l = leases.get(key(project, name));
      return l ? { ...l } : null;
    },
    async renewLease(l) {
      const held = leases.get(key(l.project, l.name));
      if (!held || held.holder !== l.holder) return false;
      held.expiresAt = new Date(l.at.getTime() + l.ttlMs).toISOString();
      return true;
    },
    async releaseLease(l) {
      const k = key(l.project, l.name);
      if (leases.get(k)?.holder === l.holder) leases.delete(k);
    },

    async pendingLaunches(project, since) {
      const held = (ticket: string) => {
        const h = handles.get(key(project, ticket));
        return !!h && !h.releasedAt;
      };
      const newest = new Map<string, LaunchRow>();
      for (const l of launches)
        if (l.project === project && l.launchedAt >= since.toISOString()) {
          const was = newest.get(l.ticket);
          if (!was || l.launchedAt > was.launchedAt) newest.set(l.ticket, l);
        }
      return [...newest.values()]
        .filter(
          (l) =>
            !l.endedAt &&
            !held(l.ticket) &&
            !events.some(
              (e) => e.project === project && e.ticket === l.ticket && e.kind === "claim" && e.at >= l.launchedAt,
            ),
        )
        .sort((a, b) => a.launchedAt.localeCompare(b.launchedAt))
        .map(({ ticket, launchedAt, tokenUsedAt, tokenExpiresAt, runtime, handle }) => ({
          ticket,
          launchedAt,
          tokenUsedAt,
          tokenExpiresAt,
          runtime,
          handle,
        }));
    },

    async expireUnusedLaunches(project, now) {
      const pending = await this.pendingLaunches(project, new Date(0));
      const expired = pending.filter((launch) => unusedLaunchExpired(launch, now));
      for (const launch of expired) {
        const row = launches.find(
          (candidate) =>
            candidate.project === project &&
            candidate.ticket === launch.ticket &&
            candidate.launchedAt === launch.launchedAt,
        );
        if (row) row.endedAt = now.toISOString();
      }
      return expired;
    },

    async addValidation(v) {
      const at = v.at.toISOString();
      for (const was of validations)
        if (
          was.project === v.project &&
          !was.decision &&
          was.kind === v.kind &&
          ((v.kind === "merge" && was.pr?.number === v.pr?.number) ||
            (v.kind === "validation" && was.ticket === v.ticket))
        )
          was.decision = { outcome: "superseded", answer: null, note: null, by: null, at };
      const { at: _at, ...rest } = v;
      const row: Validation = { ...rest, id: validations.length + 1, createdAt: at, decision: null };
      validations.push(row);
      return copy(row);
    },
    async listValidations(q) {
      const since = q.decidedSince?.toISOString() ?? "";
      return validations
        .filter(
          (v) =>
            v.project === q.project &&
            (q.ticket === undefined || v.ticket === q.ticket) &&
            (q.pr === undefined || v.pr?.number === q.pr) &&
            (!v.decision || v.decision.at >= since),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
        .map(copy);
    },
    async getValidation(project, id) {
      const v = validations.find((x) => x.project === project && x.id === id);
      return v ? copy(v) : null;
    },
    async decideValidation(d) {
      const v = validations.find((x) => x.project === d.project && x.id === d.id);
      if (!v || v.decision) return null;
      v.decision = { ...d.decision, at: d.at.toISOString() };
      const item = insert({
        project: d.project,
        ticket: v.ticket,
        kind: "decision",
        recipient: "coordinator",
        author: d.decision.by,
        body: d.body,
        createdAt: d.at.toISOString(),
        requestQuestion: null,
        requestProfile: null,
        requestValidation: v.id,
      });
      return { item };
    },
  };
}

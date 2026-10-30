import { createHash } from "node:crypto";
import { activePhaseSchema } from "@armada/protocol";
import { z } from "zod";
import { fold } from "../fold.ts";
import type { Account } from "../server/account.ts";
import type { EventStore } from "../store.ts";

export const maskHostedText = (text: string) => text.replace(/armada_(?:launch|worker)_[A-Za-z0-9_-]+/g, "[redacted]");
interface Project {
  id: string;
  name?: string;
  repository: string;
  programRoot?: string;
}
interface Options {
  store: EventStore;
  account: Pick<Account, "workerFleet">;
  projects: readonly Project[];
  now?: () => string;
  recover?: (project: string) => Promise<void>;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
}
const handleSchema = z.object({
  ticket: z.string(),
  handle: z.string(),
  claimedAt: z.iso.datetime({ offset: true }),
  workerSessionId: z.string().nullable().optional(),
  releasedAt: z.iso.datetime({ offset: true }).nullable(),
  lastHeartbeatAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
const remoteEventSchema = z.object({
  id: z.number().int().positive(),
  ticket: z.string(),
  kind: z.enum(["claim", "report", "release", "merge"]),
  at: z.iso.datetime({ offset: true }),
  handle: z.string().nullable(),
  phase: z.string().nullable(),
  message: z.string().nullable(),
  prUrl: z.string().nullable().optional(),
  headSha: z.string().nullable().optional(),
  shippingStage: z.enum(["review", "ci"]).nullable().optional(),
});
const inboxSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int().positive().nullable(),
      ticket: z.string().nullable(),
      kind: z.string(),
      author: z.string().nullable(),
      body: z.string(),
      createdAt: z.iso.datetime({ offset: true }),
    }),
  ),
});
const checkpointSchema = z.object({
  format: z.literal("armada.worker"),
  version: z.literal(1),
  type: z.literal("launch"),
  hosted: z.literal(true),
  launchId: z.string(),
  ticket: z.string(),
  session: z.string(),
  generation: z.number(),
  handle: z.string(),
  step: z.literal("launched"),
});

/** Reads durable launch identities, so a daemon restart does not lose the remote fleet. */
export class HostedReader {
  readonly #options: Options;
  #pending: Promise<void> | undefined;
  #stopped = false;
  constructor(options: Options) {
    this.#options = options;
  }
  #active(project: string) {
    const events = this.#options.store.readSince(0, project);
    const sessions = fold(events).projects[project]?.sessions ?? [];
    return events.flatMap((event) => {
      const checkpoint =
        event.kind === "coordinator.checkpoint" ? checkpointSchema.safeParse(event.payload.checkpoint) : null;
      if (!checkpoint?.success) return [];
      const launch = checkpoint.data;
      return sessions.some(
        (session) =>
          session.session === launch.session &&
          session.generation === launch.generation &&
          !["released", "merged"].includes(session.phase),
      )
        ? [{ ...launch, at: event.at }]
        : [];
    });
  }
  hasWork() {
    return this.#options.projects.some((project) => {
      if (this.#active(project.id).length) return true;
      const events = this.#options.store.readSince(0, project.id);
      const sessions = fold(events).projects[project.id]?.sessions ?? [];
      return events.some((event) => {
        const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
        return (
          c &&
          typeof c === "object" &&
          !Array.isArray(c) &&
          c.format === "armada.worker" &&
          c.type === "launch-intent" &&
          c.hosted === true &&
          typeof c.launchId === "string" &&
          sessions.some(
            (session) => session.session === c.session && !["released", "merged"].includes(session.phase),
          ) &&
          !events.some((done) => {
            const receipt = done.kind === "coordinator.checkpoint" ? done.payload.checkpoint : null;
            return (
              receipt &&
              typeof receipt === "object" &&
              !Array.isArray(receipt) &&
              receipt.format === "armada.worker" &&
              receipt.type === "receipt" &&
              receipt.key === c.key
            );
          })
        );
      });
    });
  }
  stop() {
    this.#stopped = true;
    return this.#pending ?? Promise.resolve();
  }
  poll(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#pending) return this.#pending;
    this.#pending = this.#read().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }
  async #read() {
    for (const project of this.#options.projects) {
      if (this.#stopped || !project.programRoot) continue;
      await this.#options.recover?.(project.id).catch(() => {});
      if (this.#stopped) return;
      const launches = this.#active(project.id);
      if (!launches.length) continue;
      const descriptor = {
        slug: project.id,
        name: project.name ?? project.id,
        repository: project.repository,
        programRoot: project.programRoot,
      };
      const read = (op: "inbox" | "events/since" | "runtime/handles" | "runtime/handle", input: object) =>
        this.#options.account.workerFleet(descriptor, op, input);
      try {
        const [remote, inbox] = await Promise.all([
          Promise.all(launches.map((launch) => read("runtime/handle", { ticket: launch.ticket }))),
          read("inbox", { coordinator: null, scope: "all", silentAfterMinutes: 15, etag: null }),
        ]);
        if (this.#stopped) return;
        const handles = z
          .array(handleSchema.nullable())
          .parse(remote)
          .filter((row) => row !== null);
        const items = inbox === null ? [] : inboxSchema.parse(inbox).items;
        const stillActive = (launch: (typeof launches)[number]) =>
          this.#active(project.id).some((current) => current.session === launch.session);
        const append = (
          launch: (typeof launches)[number],
          source: string,
          kind:
            | "session.claimed"
            | "session.reported"
            | "session.released"
            | "session.heartbeat"
            | "inbox.opened"
            | "inbox.answered"
            | "merge.confirmed",
          payload: unknown,
          at: string,
        ) => {
          if (this.#stopped || !stillActive(launch) || !Number.isFinite(Date.parse(at))) return;
          // Each independently committed effect owns its dedup key: a crash between the report and inbox writes is safe.
          if (
            this.#options.store.readSince(0, project.id).some((event) => event.actor === source && event.kind === kind)
          )
            return;
          this.#options.store.append({ project: project.id, kind, payload, at, actor: source } as Parameters<
            EventStore["append"]
          >[0]);
        };
        const matching = (launch: (typeof launches)[number]) =>
          handles.find(
            (row) =>
              row.ticket === launch.ticket && row.handle === launch.handle && row.workerSessionId === launch.launchId,
          );
        const held = (launch: (typeof launches)[number]) => {
          const row = matching(launch);
          return row?.releasedAt === null ? row : undefined;
        };
        for (const launch of launches) {
          const handle = held(launch);
          if (!handle) continue;
          append(
            launch,
            `armada:claim:${launch.launchId}`,
            "session.claimed",
            {
              ticket: launch.ticket,
              session: launch.session,
              generation: launch.generation,
              handle: launch.handle,
              runtime: "conductor",
              owner: "coordinator",
            },
            handle.claimedAt,
          );
        }
        for (const launch of launches) {
          const handle = held(launch);
          if (handle?.lastHeartbeatAt)
            append(
              launch,
              `armada:heartbeat:${launch.launchId}:${handle.lastHeartbeatAt}`,
              "session.heartbeat",
              { ticket: launch.ticket, session: launch.session },
              handle.lastHeartbeatAt,
            );
        }
        // Reports have no handle in V1. The current worker identity and its matching claim event ID fence generations.
        for (const launch of launches) {
          const handle = matching(launch);
          if (!handle) continue;
          const events = this.#options.store.readSince(0, project.id);
          const cursors = events.flatMap((event) => {
            const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
            return c &&
              typeof c === "object" &&
              !Array.isArray(c) &&
              c.format === "armada.worker" &&
              c.type === "hosted-cursor" &&
              c.session === launch.session &&
              typeof c.afterId === "number" &&
              typeof c.afterAt === "string"
              ? [{ afterId: c.afterId, afterAt: c.afterAt }]
              : [];
          });
          let claimId = events.reduce((found, event) => {
            const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
            return c &&
              typeof c === "object" &&
              !Array.isArray(c) &&
              c.format === "armada.worker" &&
              c.type === "hosted-claim" &&
              c.session === launch.session &&
              typeof c.remoteClaimId === "number"
              ? Math.max(found, c.remoteClaimId)
              : found;
          }, 0);
          if (!claimId) {
            const claims = await read("events/since", {
              afterId: 0,
              afterAt: new Date(Date.parse(handle.claimedAt) - 120_000).toISOString(),
              kinds: ["claim"],
              tickets: [launch.ticket],
              limit: 200,
              seenIds: [],
            });
            if (this.#stopped || !stillActive(launch)) break;
            if (claims) {
              const found = z
                .object({ events: z.array(remoteEventSchema) })
                .parse(claims)
                .events.filter(
                  (event) => event.kind === "claim" && event.ticket === launch.ticket && event.handle === launch.handle,
                )
                .sort((a, b) => b.id - a.id)[0];
              if (found) {
                claimId = found.id;
                this.#options.store.append({
                  project: project.id,
                  actor: `armada:claim-event:${found.id}`,
                  at: found.at,
                  kind: "coordinator.checkpoint",
                  payload: {
                    checkpoint: {
                      format: "armada.worker",
                      version: 1,
                      type: "hosted-claim",
                      session: launch.session,
                      remoteClaimId: claimId,
                    },
                  },
                });
              }
            }
          }
          const markSeen = (event: z.infer<typeof remoteEventSchema>) => {
            const source = `armada:event:${event.id}`;
            if (
              stillActive(launch) &&
              !this.#options.store.readSince(0, project.id).some((prior) => prior.actor === source)
            )
              this.#options.store.append({
                project: project.id,
                actor: source,
                at: event.at,
                kind: "coordinator.checkpoint",
                payload: {
                  checkpoint: { format: "armada.worker", version: 1, type: "hosted-seen", session: launch.session },
                },
              });
          };
          let cursor = cursors.at(-1) ?? {
            afterId: 0,
            afterAt: new Date(Date.parse(handle.claimedAt) - 1).toISOString(),
          };
          for (let page = 0; page < 10; page++) {
            const result = await read("events/since", {
              ...cursor,
              kinds: ["claim", "report", "release", "merge"],
              tickets: [launch.ticket],
              limit: 200,
              seenIds: this.#options.store
                .readSince(0, project.id)
                .flatMap((event) =>
                  /^armada:event:\d+$/.test(event.actor) ? [Number(event.actor.slice("armada:event:".length))] : [],
                )
                .slice(-500),
            });
            if (this.#stopped || !stillActive(launch) || !result) break;
            const parsed = z.object({ events: z.array(remoteEventSchema), cursor: z.string() }).parse(result);
            for (const event of [...parsed.events].sort((a, b) => a.id - b.id)) {
              if (event.ticket !== launch.ticket) continue;
              const source = `armada:event:${event.id}`;
              if (event.kind === "claim") {
                if (event.handle === launch.handle && event.id > claimId) {
                  claimId = event.id;
                  this.#options.store.append({
                    project: project.id,
                    actor: `armada:claim-event:${event.id}`,
                    at: event.at,
                    kind: "coordinator.checkpoint",
                    payload: {
                      checkpoint: {
                        format: "armada.worker",
                        version: 1,
                        type: "hosted-claim",
                        session: launch.session,
                        remoteClaimId: claimId,
                      },
                    },
                  });
                } else if (claimId && event.id > claimId && event.handle && event.handle !== launch.handle) {
                  append(
                    launch,
                    source,
                    "session.released",
                    { ticket: launch.ticket, session: launch.session, reason: "Worker replaced in Armada" },
                    event.at,
                  );
                }
                markSeen(event);
                continue;
              }
              if (!claimId) continue;
              if (event.id <= claimId || (event.handle && event.handle !== launch.handle)) {
                markSeen(event);
                continue;
              }
              if (event.kind === "report") {
                const phase = activePhaseSchema.safeParse(event.phase);
                const newer = this.#options.store
                  .readSince(0, project.id)
                  .some(
                    (prior) =>
                      prior.kind === "session.reported" &&
                      prior.payload.session === launch.session &&
                      /^armada:event:\d+$/.test(prior.actor) &&
                      Number(prior.actor.slice("armada:event:".length)) > event.id,
                  );
                if (newer) {
                  if (!this.#options.store.readSince(0, project.id).some((prior) => prior.actor === source))
                    this.#options.store.append({
                      project: project.id,
                      actor: source,
                      at: event.at,
                      kind: "coordinator.checkpoint",
                      payload: {
                        checkpoint: {
                          format: "armada.worker",
                          version: 1,
                          type: "hosted-seen",
                          session: launch.session,
                        },
                      },
                    });
                }
                if (phase.success && !newer)
                  append(
                    launch,
                    source,
                    "session.reported",
                    {
                      ticket: launch.ticket,
                      session: launch.session,
                      phase: phase.data,
                      reason: maskHostedText(event.message ?? phase.data),
                      ...(event.shippingStage ? { stage: event.shippingStage } : {}),
                    },
                    event.at,
                  );
              } else if (event.kind === "release" || event.kind === "merge") {
                for (const pending of fold(this.#options.store.readSince(0, project.id)).projects[project.id]?.inbox ??
                  []) {
                  if (pending.ticket === launch.ticket && pending.id.startsWith("armada:inbox:"))
                    append(
                      launch,
                      `${source}:closed:${pending.id}`,
                      "inbox.answered",
                      { id: pending.id, answer: "Worker released in Armada" },
                      event.at,
                    );
                }
                let merged = false;
                if (event.kind === "merge" && event.prUrl && event.headSha && /^[0-9a-f]{40}$/.test(event.headSha)) {
                  const url = new URL(event.prUrl);
                  const [owner, repository, pull, number] = url.pathname.split("/").filter(Boolean);
                  const pr = Number(number);
                  if (
                    url.hostname === "github.com" &&
                    `${owner}/${repository}`.toLowerCase() === project.repository.toLowerCase() &&
                    pull === "pull" &&
                    Number.isSafeInteger(pr) &&
                    pr > 0
                  ) {
                    append(
                      launch,
                      source,
                      "merge.confirmed",
                      { id: source, ticket: launch.ticket, session: launch.session, pr, head: event.headSha },
                      event.at,
                    );
                    merged = true;
                  }
                }
                if (!merged)
                  append(
                    launch,
                    source,
                    "session.released",
                    {
                      ticket: launch.ticket,
                      session: launch.session,
                      reason: maskHostedText(event.message ?? "Ended in Armada"),
                    },
                    event.at,
                  );
              }
            }
            const last = parsed.events.at(-1);
            if (!last) break;
            const advanced = last.at > cursor.afterAt || (last.at === cursor.afterAt && last.id > cursor.afterId);
            if (advanced) cursor = { afterId: last.id, afterAt: last.at };
            if (!this.#stopped && advanced)
              this.#options.store.append({
                project: project.id,
                at: this.#options.now?.() ?? new Date().toISOString(),
                actor: "reader",
                kind: "coordinator.checkpoint",
                payload: {
                  checkpoint: {
                    format: "armada.worker",
                    version: 1,
                    type: "hosted-cursor",
                    session: launch.session,
                    ...cursor,
                  },
                },
              });
            if (parsed.events.length < 200) break;
          }
        }
        for (const launch of launches) {
          const row = matching(launch);
          if (!row?.releasedAt || !stillActive(launch)) continue;
          for (const pending of fold(this.#options.store.readSince(0, project.id)).projects[project.id]?.inbox ?? [])
            if (pending.ticket === launch.ticket && pending.id.startsWith("armada:inbox:"))
              append(
                launch,
                `armada:ended:${launch.launchId}:${pending.id}`,
                "inbox.answered",
                { id: pending.id, answer: "Worker ended in Armada" },
                row.releasedAt,
              );
          append(
            launch,
            `armada:ended:${launch.launchId}`,
            "session.released",
            { ticket: launch.ticket, session: launch.session, reason: "Worker ended in Armada" },
            row.releasedAt,
          );
        }
        for (const item of items) {
          const launch = launches.find(
            (launch) =>
              item.ticket === launch.ticket &&
              (item.author === launch.handle || item.author === launch.launchId) &&
              held(launch),
          );
          if (!launch || !item.id || !["question", "plan", "hand-back"].includes(item.kind)) continue;
          const revision = createHash("sha256")
            .update(JSON.stringify([item.body, item.createdAt, item.author, launch.launchId]))
            .digest("hex");
          const actor = `armada:inbox:${item.id}:${revision}`;
          const table = fold(this.#options.store.readSince(0, project.id)).projects[project.id];
          for (const previous of table?.inbox ?? []) {
            if (previous.id.startsWith(`armada:inbox:${item.id}:`) && previous.id !== actor)
              append(
                launch,
                `${actor}:superseded`,
                "inbox.answered",
                { id: previous.id, answer: "Superseded by a newer worker report" },
                item.createdAt,
              );
          }
          append(
            launch,
            actor,
            "inbox.opened",
            { id: actor, ticket: launch.ticket, kind: item.kind, body: maskHostedText(item.body) },
            item.createdAt,
          );
          // Prefer the report feed; an inbox item supplies phase only when no equally new report already does.
          const desired =
            item.kind === "hand-back" ? "ready-to-merge" : item.kind === "plan" ? "awaiting-approval" : "blocked";
          const already = table?.sessions.find((session) => session.session === launch.session)?.phase === desired;
          const newer =
            item.kind !== "question" &&
            this.#options.store
              .readSince(0, project.id)
              .some(
                (event) =>
                  event.kind === "session.reported" &&
                  event.payload.session === launch.session &&
                  event.actor.startsWith("armada:event:"),
              );
          if (!already && !newer)
            append(
              launch,
              actor,
              "session.reported",
              {
                ticket: launch.ticket,
                session: launch.session,
                phase:
                  item.kind === "hand-back" ? "ready-to-merge" : item.kind === "plan" ? "awaiting-approval" : "blocked",
                reason: maskHostedText(item.body),
              },
              item.createdAt,
            );
        }
        if (inbox !== null)
          for (const launch of launches) {
            if (!held(launch) || !stillActive(launch)) continue;
            const pending = fold(this.#options.store.readSince(0, project.id)).projects[project.id]?.inbox ?? [];
            for (const item of pending) {
              const remoteId = /^armada:inbox:(\d+):/.exec(item.id)?.[1];
              if (
                item.ticket === launch.ticket &&
                remoteId &&
                !items.some(
                  (remote) =>
                    String(remote.id) === remoteId &&
                    (remote.author === launch.handle || remote.author === launch.launchId),
                )
              )
                append(
                  launch,
                  `armada:resolved:${item.id}`,
                  "inbox.answered",
                  { id: item.id, answer: "Resolved in Armada" },
                  this.#options.now?.() ?? new Date().toISOString(),
                );
            }
          }
      } catch {
        // Account/network/shape failures cannot import partial unvalidated remote bodies or expose their text.
      }
    }
  }
}

/** One timer per daemon, single-flight reads, and no remote requests while the hosted fleet is empty. */
export function startHostedReader(options: Options) {
  const reader = new HostedReader(options);
  const schedule =
    options.schedule ??
    ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return () => clearTimeout(timer);
    });
  let cancel: (() => void) | undefined;
  let stopped = false;
  let polling = false;
  const arm = () => {
    if (stopped || !reader.hasWork()) {
      cancel?.();
      cancel = undefined;
      return;
    }
    if (cancel || polling) return;
    cancel = schedule(() => {
      cancel = undefined;
      polling = true;
      void reader.poll().finally(() => {
        polling = false;
        arm();
      });
    }, 15_000);
  };
  const unsubscribe = options.store.subscribe(arm);
  arm();
  return {
    reader,
    async stop() {
      stopped = true;
      cancel?.();
      unsubscribe();
      await reader.stop();
    },
  };
}

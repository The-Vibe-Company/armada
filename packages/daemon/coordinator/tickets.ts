import { createHash } from "node:crypto";
import type { TrackerCreateRequest, TrackerProvider, TrackerUpdateRequest } from "@armada/plugin-api";
import type { JsonObject } from "@earendil-works/pi-durable";
import { z } from "zod";
import { fold } from "../src/fold.ts";
import { refusalLine, refuse } from "../src/merge/refusal.ts";
import type { CoordinatorStorage } from "./storage.ts";

const id = z.string().min(1).max(200).regex(/\S/);
const labels = z.array(id).max(100);
const fields = {
  title: z.string().min(1).max(4000).regex(/\S/),
  description: z.string().max(100000),
  labels,
  parent: id.nullable(),
  blockers: z.array(id).max(100),
};
export const ticketToolSchemas = {
  "ticket.create": z.strictObject({
    title: fields.title,
    description: fields.description,
    labels: labels.optional(),
    parent: fields.parent.optional(),
    blockers: fields.blockers.optional(),
    ready: z.boolean().optional(),
  }),
  "ticket.update": z.strictObject({
    id,
    title: fields.title.optional(),
    description: fields.description.optional(),
    labels: labels.optional(),
    addLabels: labels.optional(),
    removeLabels: labels.optional(),
    state: z.enum(["backlog", "unstarted", "started", "completed", "canceled"]).optional(),
    parent: fields.parent.optional(),
    blockers: fields.blockers.optional(),
  }),
  "ticket.comment": z.strictObject({ id, body: z.string().min(1).max(100000).regex(/\S/) }),
};
export type TicketTool = keyof typeof ticketToolSchemas;
/** What a ticket call needs of its writer: the coordinator's storage, or the owner's scope on the Tickets page. */
export type TicketStorage = Pick<CoordinatorStorage, "project" | "readEvents" | "appendEvent">;
export interface TicketToolOptions {
  now: () => string;
  /** Who decides the call: its journal's and its tracker writes' actor. The coordinator's unless the owner's page (THE-2124). */
  author?: "coordinator" | "owner";
  /** Additional host fence, checked at the provider's commit boundary. */
  beforeWrite?: () => void;
  /** Resolve the project's currently configured, scoped provider at the point of use. */
  trackerProvider?: () => TrackerProvider | undefined;
  /** Host-only import facts; never accepted by the coordinator's tool schemas. */
  importing?: {
    create?: Pick<TrackerCreateRequest, "state" | "source" | "url">;
    comment?: { id: string; author: string; at: string };
  };
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const conflict = () =>
  refuse(
    "call_conflict",
    "this call identity already committed different arguments",
    "inspect the original call; use a new call for a new decision",
  );
const serial = new WeakMap<TicketStorage, Promise<unknown>>();

/** The provider owns ticket writes; this journal owns the coordinator's durable call identity.
 * Intent precedes the side effect. A keyed actor lets the internal tracker's committed
 * event recover a lost response without guessing an id or repeating create. Providers
 * without inspectable evidence leave an interrupted create/update explicitly uncertain.
 */
export async function ticketTool(
  scope: TicketStorage,
  options: TicketToolOptions,
  name: TicketTool,
  args: unknown,
  key: string,
): Promise<JsonObject> {
  const previous = serial.get(scope) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => execute(scope, options, name, args, key));
  serial.set(scope, next);
  try {
    return await next;
  } finally {
    if (serial.get(scope) === next) serial.delete(scope);
  }
}

async function execute(
  scope: TicketStorage,
  options: TicketToolOptions,
  name: TicketTool,
  args: unknown,
  key: string,
): Promise<JsonObject> {
  try {
    const parsed = ticketToolSchemas[name].safeParse(args);
    if (!parsed.success)
      return refuse(
        "invalid_arguments",
        "tool arguments do not match its schema",
        `call ${name} with its declared parameters`,
      );
    const input = canonical({
      name,
      args: parsed.data,
      ...(options.importing ? { importing: options.importing } : {}),
    });
    const events = scope.readEvents();
    let pending = false;
    for (const event of events) {
      if (event.kind !== "coordinator.checkpoint") continue;
      const c = event.payload.checkpoint;
      if (!c || typeof c !== "object" || Array.isArray(c) || c.format !== "armada.tickets" || c.key !== key) continue;
      if (c.version !== 1)
        return refuse(
          "unsupported_receipt",
          "unsupported ticket call journal version",
          "upgrade the daemon before replaying this call",
        );
      if (c.input !== input) return conflict();
      if (c.type === "receipt") {
        const result = z.object({ ok: z.literal(true), id }).safeParse(c.result);
        if (!result.success)
          return refuse("unsupported_receipt", "invalid ticket call receipt", "upgrade or repair the project log");
        return result.data;
      }
      if (c.type !== "intent")
        return refuse(
          "unsupported_receipt",
          "unsupported ticket call journal entry",
          "upgrade the daemon before replaying this call",
        );
      pending = true;
    }
    const author = options.author ?? "coordinator";
    const hash = digest(key);
    const actor = `${author}:ticket:${hash}`;
    // TrackerWriteRequest requires a stable UUID; Linear forwards it as CommentCreateInput.id.
    const commentId =
      options.importing?.comment?.id ??
      `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const record = (type: string, result?: JsonObject) =>
      scope.appendEvent({
        project: scope.project,
        actor: author,
        at: options.now(),
        kind: "coordinator.checkpoint",
        payload: {
          checkpoint: { format: "armada.tickets", version: 1, type, key, input, ...(result ? { result } : {}) },
        },
      });
    const commit = (result: JsonObject) => {
      record("receipt", result);
      return result;
    };
    const action = parsed.data;
    if (pending) {
      const effect = events.find(
        (event) =>
          (name === "ticket.create" && event.kind === "ticket.created" && event.actor === actor) ||
          (name === "ticket.update" && event.kind === "ticket.edited" && event.actor === actor) ||
          (name === "ticket.comment" &&
            event.kind === "ticket.commented" &&
            event.payload.id === commentId &&
            event.payload.ticket === (action as { id: string }).id),
      );
      if (effect)
        return commit({
          ok: true,
          id: effect.kind === "ticket.created" ? effect.payload.id : (action as { id: string }).id,
        });
      // A trusted import targets only the event-backed internal provider. Its
      // complete history proves an absent keyed effect never committed, so it
      // can retry safely. External/ordinary tool outcomes remain uncertain.
      if (name !== "ticket.comment" && !options.importing)
        return refuse(
          "ticket_outcome_unknown",
          "the tracker action's outcome is unknown; inspect the ticket history before making a new decision",
          "fleet.history",
        );
    }
    const tracker = options.trackerProvider?.();
    if (!tracker)
      return refuse(
        "tracker_unavailable",
        "the project's tracker is unavailable",
        "open the project's tracker settings",
      );
    if ((name === "ticket.create" && !tracker.create) || (name === "ticket.update" && !tracker.update))
      return refuse(
        "tracker_unsupported",
        "the project's tracker cannot create tickets; write it in Linear",
        "write it in Linear",
      );
    const beforeWrite = () => {
      scope.readEvents();
      options.beforeWrite?.();
    };
    let patch: TrackerUpdateRequest["patch"] = {};
    if ("id" in action) {
      const current = fold(events).projects[scope.project]?.tickets.find((ticket) => ticket.id === action.id);
      if (!current) return refuse("no_ticket", `ticket ${action.id} not found`, "ticket.read with a known ticket id");
      if (name === "ticket.update") {
        const edit = action as z.infer<(typeof ticketToolSchemas)["ticket.update"]>;
        const { id: _id, addLabels, removeLabels, ...changes } = edit;
        patch = changes;
        if (edit.labels !== undefined || addLabels !== undefined || removeLabels !== undefined)
          patch.labels = [...new Set([...(edit.labels ?? current.labels ?? []), ...(addLabels ?? [])])].filter(
            (label) => !removeLabels?.includes(label),
          );
        if (!Object.keys(patch).length)
          return refuse("invalid_arguments", "say which ticket fields change", "ticket.update with a patch");
      }
    }
    if (!pending) record("intent");
    let result: JsonObject;
    try {
      if (name === "ticket.create") {
        const create = action as z.infer<(typeof ticketToolSchemas)["ticket.create"]>;
        const created = await tracker.create?.({
          project: scope.project,
          actor,
          beforeWrite,
          title: create.title,
          description: create.description,
          labels: [...new Set([...(create.labels ?? []), ...(create.ready ? ["ready-for-agent"] : [])])],
          ...(create.parent !== undefined ? { parent: create.parent } : {}),
          ...(create.blockers !== undefined ? { blockers: create.blockers } : {}),
          ...options.importing?.create,
        });
        if (!id.safeParse(created?.id).success) throw new Error("Tracker returned an invalid ticket id");
        result = { ok: true, id: created?.id as string };
      } else if (name === "ticket.update") {
        const edit = action as z.infer<(typeof ticketToolSchemas)["ticket.update"]>;
        await tracker.update?.({ project: scope.project, actor, beforeWrite, ticket: edit.id, patch });
        result = { ok: true, id: edit.id };
      } else {
        const comment = action as z.infer<(typeof ticketToolSchemas)["ticket.comment"]>;
        const imported = options.importing?.comment;
        if (imported) {
          // Only the trusted internal import host supplies original Linear provenance.
          // Keep it in this journal so interrupted comments recover like other ticket calls.
          beforeWrite();
          if (
            !events.some(
              (event) =>
                event.kind === "ticket.commented" &&
                event.payload.ticket === comment.id &&
                event.payload.id === commentId,
            )
          )
            scope.appendEvent({
              project: scope.project,
              actor: imported.author,
              at: imported.at,
              kind: "ticket.commented",
              payload: { ticket: comment.id, id: commentId, body: comment.body, author: imported.author },
            });
        } else
          await tracker.write({
            project: scope.project,
            actor: author,
            beforeWrite,
            ticket: comment.id,
            comment: comment.body,
            commentId,
          });
        result = { ok: true, id: comment.id };
      }
    } catch (error) {
      beforeWrite();
      return refuse(
        "tracker_write_failed",
        refusalLine(error, "the tracker action could not be confirmed"),
        `retry ${name} with the same call identity`,
      );
    }
    return commit(result);
  } catch {
    try {
      scope.readEvents();
    } catch {
      return refuse(
        "coordinator_inactive",
        "the project's coordinator no longer owns its writer scope",
        "open the project's coordinator",
      );
    }
    return refuse(
      "ticket_write_failed",
      "the ticket action could not be recorded",
      `retry ${name} with the same call identity`,
    );
  }
}

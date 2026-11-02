import { randomUUID } from "node:crypto";
import type { PluginContext, PluginEventInput, TrackerProvider } from "@armada/plugin-api";
import { type FleetTables, phaseSchema, ticketCreatedSchema, ticketPatchSchema } from "@armada/protocol";
import { z } from "zod";

const identity = z.string().trim().min(1);
const mutationSchema = z.object({ project: identity, actor: identity.default("coordinator") });
const createFields = ticketCreatedSchema.omit({ id: true }).extend({
  state: ticketCreatedSchema.shape.state.default("backlog"),
  parent: ticketCreatedSchema.shape.parent.default(null),
  blockers: ticketCreatedSchema.shape.blockers.default([]),
});
const createSchema = z.object(createFields.shape);
const writeSchema = z
  .object({
    ticket: identity,
    phase: phaseSchema.optional(),
    state: z.literal("completed").optional(),
    comment: z.string().optional(),
    commentId: identity.optional(),
  })
  .refine((r) => r.commentId === undefined || r.comment !== undefined, "commentId needs a comment");

export function activate(ctx: PluginContext): void {
  // This capability is optional for other plugins and older hosts. Refuse writes
  // explicitly rather than emulate allocation with a racy read-then-append.
  const append = (project: string, build: (tables: FleetTables) => PluginEventInput[]) => {
    if (!ctx.events.appendWith) throw new Error("Internal tracker requires atomic event append support");
    return ctx.events.appendWith(project, (tables) => build(tables as FleetTables));
  };
  // Internal ownership is monotonic in this append-only log. Check the full
  // history rather than mistaking an external ticket.seen row for our ticket.
  const historyFor = async (project: string, ticket: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const history = await ctx.events.read(project, 0);
    signal?.throwIfAborted();
    if (
      !history.some(
        (e) =>
          e.kind === "ticket.created" &&
          typeof e.payload === "object" &&
          e.payload !== null &&
          !Array.isArray(e.payload) &&
          e.payload.id === ticket,
      )
    )
      throw new Error("Internal ticket not found");
    return history;
  };
  const provider: TrackerProvider = {
    async read({ signal }) {
      signal?.throwIfAborted();
    },
    async status() {
      return { installed: true, state: "connected" };
    },
    async create(request) {
      const { project, actor } = mutationSchema.parse(request);
      const fields = createSchema.parse(request);
      const prefix = project
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .slice(0, 5);
      if (!prefix) throw new Error("Internal ticket project id must contain a letter");
      const events = await append(project, (tables) => {
        request.signal?.throwIfAborted();
        let highest = 0;
        for (const ticket of tables.projects[project]?.tickets ?? []) {
          if (!ticket.id.startsWith(`${prefix}-`)) continue;
          const suffix = ticket.id.slice(prefix.length + 1);
          if (/^[0-9]+$/.test(suffix)) highest = Math.max(highest, Number(suffix));
        }
        if (!Number.isSafeInteger(highest + 1)) throw new Error("Internal ticket numbers exhausted");
        const payload = ticketCreatedSchema.parse({ ...fields, id: `${prefix}-${highest + 1}` });
        request.beforeWrite?.();
        return [{ project, actor, at: new Date().toISOString(), kind: "ticket.created", payload }];
      });
      return { id: ticketCreatedSchema.parse(events[0]?.payload).id };
    },
    async update(request) {
      const { project, actor } = mutationSchema.parse(request);
      const ticket = identity.parse(request.ticket);
      const patch = ticketPatchSchema.parse(request.patch);
      await historyFor(project, ticket, request.signal);
      await append(project, (tables) => {
        request.signal?.throwIfAborted();
        if (!tables.projects[project]?.tickets.some((t) => t.id === ticket))
          throw new Error("Internal ticket not found");
        request.beforeWrite?.();
        return [{ project, actor, at: new Date().toISOString(), kind: "ticket.edited", payload: { ticket, patch } }];
      });
    },
    async write(request) {
      const { project, actor } = mutationSchema.parse(request);
      const { ticket, phase, state, comment, commentId } = writeSchema.parse(request);
      const history = await historyFor(project, ticket, request.signal);
      if (phase !== undefined || state !== undefined)
        await append(project, (tables) => {
          request.signal?.throwIfAborted();
          const current = tables.projects[project]?.tickets.find((t) => t.id === ticket);
          if (!current) throw new Error("Internal ticket not found");
          const patch = {
            ...(phase !== undefined
              ? { labels: [...(current.labels ?? []).filter((label) => !phaseSchema.safeParse(label).success), phase] }
              : {}),
            ...(state !== undefined ? { state } : {}),
          };
          request.beforeWrite?.();
          return [{ project, actor, at: new Date().toISOString(), kind: "ticket.edited", payload: { ticket, patch } }];
        });
      if (comment !== undefined) {
        const id = commentId ?? randomUUID();
        // Check the full log, not the visible last twelve comments. The fold also
        // deduplicates ids when replaying imported or repeated event envelopes.
        if (
          history.some(
            (e) =>
              e.kind === "ticket.commented" &&
              typeof e.payload === "object" &&
              e.payload !== null &&
              !Array.isArray(e.payload) &&
              e.payload.ticket === ticket &&
              e.payload.id === id,
          )
        )
          return;
        await append(project, (tables) => {
          request.signal?.throwIfAborted();
          if (!tables.projects[project]?.tickets.some((t) => t.id === ticket))
            throw new Error("Internal ticket not found");
          request.beforeWrite?.();
          return [
            {
              project,
              actor,
              at: new Date().toISOString(),
              kind: "ticket.commented",
              payload: { ticket, id, body: comment, author: actor },
            },
          ];
        });
      }
      request.signal?.throwIfAborted();
    },
  };
  ctx.register.tracker("internal", provider);
}

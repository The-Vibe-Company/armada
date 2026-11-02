import { createHash, randomUUID } from "node:crypto";
import type { TrackerProgramReading, TrackerProvider } from "@armada/plugin-api";
import { internalTicketFieldsSchema, type TrackerImport } from "@armada/protocol";
import { z } from "zod";
import { type TicketStorage, type TicketTool, type TicketToolOptions, ticketTool } from "../../coordinator/tickets.ts";
import type { EventInput } from "../events.ts";
import type { EventStore } from "../store.ts";

const readingSchema = z.object({
  tickets: z.array(internalTicketFieldsSchema.extend({ id: z.string().min(1) })),
  comments: z.array(
    z.object({
      id: z.string().min(1),
      ticket: z.string().min(1),
      body: z.string(),
      author: z.string().min(1),
      at: z.iso.datetime(),
    }),
  ),
});
interface Options {
  store: EventStore;
  project: (id: string) => { id: string; tracker: string; phaseGroup?: string; readyLabel?: string } | undefined;
  tracker: (kind: string, project: string) => TrackerProvider | undefined;
  now?: () => string;
  projects?: readonly string[];
}
type Running = { id: string; root: string; controller: AbortController; done: Promise<TrackerImport> };
const createKey = (source: string) => `import:${source}:create`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export class ImportRefusal extends Error {}

/** One host-owned chore per project. Only complete reader exports cross into ticket mutations. */
export class Imports {
  readonly #options: Options;
  readonly #running = new Map<string, Running>();
  readonly #scopes = new Map<string, TicketStorage>();
  readonly #stopping = new Set<string>();
  #closed = false;
  constructor(options: Options) {
    this.#options = options;
  }
  /** The host calls this after readiness; admission recovers its own project on demand. */
  recover() {
    for (const project of this.#options.projects ?? []) this.#recover(project);
  }
  #recover(project: string) {
    if (this.#running.has(project) || this.#stopping.has(project) || this.#closed) return;
    const previous = this.#options.store.fold(project).projects[project]?.trackerImport;
    if (previous?.state === "running")
      this.#record(project, "tracker.import-ended", {
        ...previous,
        state: "interrupted",
        error: "Import interrupted; run the command again to continue.",
      });
  }
  #record(
    project: string,
    kind: "tracker.import-started" | "tracker.import-progress" | "tracker.import-ended",
    value: TrackerImport & { source?: string },
  ) {
    this.#options.store.append({
      project,
      kind,
      actor: "coordinator",
      at: this.#options.now?.() ?? new Date().toISOString(),
      payload: value,
    });
  }
  start(project: string, programRoot: string): { id: string; done: Promise<TrackerImport> } {
    if (this.#closed) throw new ImportRefusal("Import service is closed");
    if (this.#stopping.has(project)) throw new ImportRefusal("This project is being removed");
    const target = this.#options.project(project);
    if (!target) throw new ImportRefusal("Unknown fleet project");
    if (target.tracker === "linear")
      throw new ImportRefusal("this project reads Linear live; add it without Linear to import");
    if (target.tracker !== "internal") throw new ImportRefusal("This project does not use Armada's internal tickets");
    if (!programRoot.trim() || programRoot.length > 200) throw new ImportRefusal("A Linear program root is required");
    const active = this.#running.get(project);
    if (active) {
      if (active.root !== programRoot) throw new ImportRefusal("Another program import is running for this project");
      return active;
    }
    const reader = this.#options.tracker("linear", project);
    if (!reader?.readProgram) throw new ImportRefusal("The Linear plugin cannot export a program; enable or update it");
    this.#recover(project);
    const controller = new AbortController();
    const value: TrackerImport = {
      id: randomUUID(),
      programRoot,
      state: "running",
      imported: 0,
      skipped: 0,
      comments: 0,
      total: 0,
    };
    this.#record(project, "tracker.import-started", value);
    const done = Promise.resolve()
      .then(async () => {
        try {
          const result = await reader.readProgram!({
            project,
            programRoot,
            phaseGroup: target.phaseGroup,
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          if (result.pausedUntil) {
            value.state = "paused";
            value.pausedUntil = z.iso.datetime().parse(result.pausedUntil);
          } else {
            const reading = readingSchema.parse(result.reading);
            if (
              new Set(reading.tickets.map((t) => t.id)).size !== reading.tickets.length ||
              !reading.tickets.some((t) => t.id === programRoot)
            )
              throw new Error("Incomplete program");
            await this.#import(project, reading, value, controller.signal);
            value.state = "completed";
          }
        } catch {
          value.state = controller.signal.aborted ? "interrupted" : "failed";
          value.error = controller.signal.aborted
            ? "Import interrupted; run the command again to continue."
            : "Import failed; check the Linear connection and retry. Completed tickets are kept.";
        }
        this.#record(project, "tracker.import-ended", value);
        return { ...value };
      })
      .finally(() => this.#running.delete(project));
    this.#running.set(project, { id: value.id, root: programRoot, controller, done });
    return { id: value.id, done };
  }
  async #import(project: string, reading: TrackerProgramReading, value: TrackerImport, signal: AbortSignal) {
    const { store } = this.#options;
    const current = () => {
      signal.throwIfAborted();
      if (this.#closed || this.#stopping.has(project) || this.#options.project(project)?.tracker !== "internal")
        throw new Error("Import target changed");
    };
    let scope = this.#scopes.get(project);
    if (!scope) {
      scope = {
        project,
        readEvents: () => store.readSince(0, project),
        appendEvent: (event: EventInput) => store.append(event),
      };
      this.#scopes.set(project, scope);
    }
    // Owner requests use the existing executor and durable receipts without starting a coordinator.
    const fenced: TicketStorage = {
      project,
      readEvents: () => {
        current();
        return scope.readEvents();
      },
      appendEvent: (event) => {
        current();
        return scope.appendEvent(event);
      },
    };
    const call = async (name: TicketTool, args: unknown, key: string, importing?: TicketToolOptions["importing"]) => {
      current();
      const since = store.sequence;
      const patch = name === "ticket.update" ? (args as { id: string } & Record<string, unknown>) : undefined;
      const result = await ticketTool(
        fenced,
        {
          now: () => this.#options.now?.() ?? new Date().toISOString(),
          trackerProvider: () => {
            current();
            return this.#options.tracker("internal", project);
          },
          importing: importing ?? {},
          beforeWrite: () => {
            if (!patch) return;
            if (
              store
                .readSince(since, project)
                .some(
                  (event) =>
                    event.kind === "ticket.edited" &&
                    event.payload.ticket === patch.id &&
                    event.actor !== `coordinator:ticket:${hash(key)}` &&
                    Object.keys(event.payload.patch).some((field) => Object.hasOwn(patch, field)),
                )
            )
              throw new Error("Ticket changed while importing; retry to preserve the owner's edits");
          },
        },
        name,
        args,
        key,
      );
      if (result.ok !== true || typeof result.id !== "string") throw new Error("Ticket import failed");
      return result.id;
    };
    const history = store.readSince(0, project);
    const changedFields = (id: string) =>
      new Set(
        store
          .readSince(0, project)
          .flatMap((event) =>
            event.kind === "ticket.edited" && event.payload.ticket === id ? Object.keys(event.payload.patch) : [],
          ),
      );
    const sources = new Map(
      history.flatMap((e) =>
        e.kind === "ticket.created" && e.payload.source ? [[e.payload.source, e.payload.id] as const] : [],
      ),
    );
    const finished = new Set(
      history.flatMap((e) => (e.kind === "tracker.import-progress" && e.payload.source ? [e.payload.source] : [])),
    );
    const resumed = new Set(
      history.flatMap((e) =>
        e.kind === "ticket.created" &&
        e.payload.source &&
        e.actor === `coordinator:ticket:${hash(createKey(e.payload.source))}` &&
        !finished.has(e.payload.source)
          ? [e.payload.source]
          : [],
      ),
    );
    const program = new Set(reading.tickets.map((t) => t.id));
    const readyLabel = this.#options.project(project)?.readyLabel ?? "ready-for-agent";
    const selected = reading.tickets.filter((t) => !sources.has(t.id) || resumed.has(t.id));
    value.total = reading.tickets.length;
    value.skipped = value.total - selected.length;
    this.#record(project, "tracker.import-progress", value);
    for (const ticket of selected) {
      current();
      if (!sources.has(ticket.id))
        sources.set(
          ticket.id,
          await call(
            "ticket.create",
            {
              title: ticket.title,
              description: ticket.description,
              labels: ticket.labels.filter((label) => label !== readyLabel && label !== "ready-for-agent"),
            },
            createKey(ticket.id),
            { create: { state: ticket.state, source: ticket.id, url: ticket.url } },
          ),
        );
    }
    for (const ticket of selected) {
      const id = sources.get(ticket.id)!;
      // A retry completes only fields that have not been edited since creation.
      // This also recovers a relation write whose response or receipt was lost.
      const changed = changedFields(id);
      const relations = {
        id,
        ...(!changed?.has("parent")
          ? { parent: ticket.parent && program.has(ticket.parent) ? (sources.get(ticket.parent) ?? null) : null }
          : {}),
        ...(!changed?.has("blockers") ? { blockers: ticket.blockers.map((b) => sources.get(b) ?? b) } : {}),
      };
      if (Object.keys(relations).length > 1)
        await call("ticket.update", relations, `import:${ticket.id}:relations:${hash(JSON.stringify(relations))}`);
      for (const comment of reading.comments.filter((c) => c.ticket === ticket.id)) {
        const commentKey = `import:${ticket.id}:comment:${comment.id}`;
        // Once committed, a later edit of the external comment is not a second comment.
        if (
          !store
            .readSince(0, project)
            .some((e) => e.kind === "ticket.commented" && e.payload.ticket === id && e.payload.id === comment.id)
        ) {
          await call("ticket.comment", { id, body: comment.body }, commentKey, {
            comment: { id: comment.id, author: comment.author, at: comment.at },
          });
        }
        value.comments++;
      }
      // A visible ready ticket always has its imported relationships and comments.
      // Respect an owner's label edit on an interrupted source as well.
      if (
        !changedFields(id).has("labels") &&
        ticket.labels.some((label) => label === readyLabel || label === "ready-for-agent")
      )
        await call(
          "ticket.update",
          { id, labels: ticket.labels },
          `import:${ticket.id}:ready:${hash(JSON.stringify(ticket.labels))}`,
        );
      current();
      value.imported++;
      this.#record(project, "tracker.import-progress", { ...value, source: ticket.id });
    }
  }
  async stopProject(project: string) {
    this.#stopping.add(project);
    const running = this.#running.get(project);
    running?.controller.abort();
    await running?.done;
    this.#scopes.delete(project);
  }
  openProject(project: string) {
    this.#stopping.delete(project);
  }
  async close() {
    this.#closed = true;
    for (const running of this.#running.values()) running.controller.abort();
    await Promise.allSettled([...this.#running.values()].map((r) => r.done));
  }
}

// The Tickets page's writes (THE-2124): the owner creates and edits a project's
// tickets through the coordinator's own ticket tools (coordinator/tickets.ts),
// with the owner as their author and the request's `requestId` as the call's
// identity, through the project's tracker as the coordinator's are. Each
// request answers once: `ticket.result`, or its refusal as one `error` line.
import type { TrackerProvider } from "@armada/plugin-api";
import { type ServerMessage, type TicketRequest, PROTOCOL_VERSION as version } from "@armada/protocol";
import { type TicketStorage, ticketTool } from "../../coordinator/tickets.ts";
import type { EventStore } from "../store.ts";

export interface TicketsOptions {
  store: EventStore;
  /** The project's configured tracker, resolved at the point of use. */
  trackerFor?: ((project: string) => TrackerProvider | undefined) | undefined;
  now?: () => string;
}

// One owner scope per project and store: the tool's calls on it run one at a time.
const scopes = new WeakMap<EventStore, Map<string, TicketStorage>>();
function ownerScope(store: EventStore, project: string): TicketStorage {
  const byProject = scopes.get(store) ?? new Map<string, TicketStorage>();
  scopes.set(store, byProject);
  let scope = byProject.get(project);
  if (!scope) {
    scope = {
      project,
      readEvents: () => store.readSince(0, project),
      appendEvent: (event) => {
        if (event.project !== project) throw new Error("Ticket write is outside its project scope");
        return store.append(event);
      },
    };
    byProject.set(project, scope);
  }
  return scope;
}

/** Answers one of the Tickets page's requests. */
export async function dispatchTickets(request: TicketRequest, options: TicketsOptions): Promise<ServerMessage> {
  const { id, project, requestId } = request;
  // The tool's arguments are the request's fields; an update names its ticket `id`, as the tool does.
  let args: Record<string, unknown>;
  if (request.type === "ticket.update") {
    const { type: _t, version: _v, id: _i, project: _p, requestId: _r, ticket, ...patch } = request;
    args = { id: ticket, ...patch };
  } else {
    const { type: _t, version: _v, id: _i, project: _p, requestId: _r, ...fields } = request;
    args = fields;
  }
  const result = await ticketTool(
    ownerScope(options.store, project),
    {
      author: "owner",
      now: options.now ?? (() => new Date().toISOString()),
      trackerProvider: () => options.trackerFor?.(project),
    },
    request.type,
    args,
    JSON.stringify(["owner", project, requestId]),
  );
  if (result.ok === true && typeof result.id === "string")
    return { type: "ticket.result", version, id, project, requestId, ticket: result.id };
  const message = typeof result.message === "string" && result.message ? result.message : "The ticket was not saved";
  return { type: "error", version, id, code: "denied", message };
}

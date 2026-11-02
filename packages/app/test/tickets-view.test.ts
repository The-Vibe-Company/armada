import { expect, test } from "bun:test";
import type { FleetState, FoldedTicket } from "../src/fleet/state";
import { languageOf, STRINGS, translate } from "../src/lib/i18n";
import { routeOf, ticketsHref } from "../src/lib/route";
import { createFields, draftOf, requestWrites, ticketRows, updateFields } from "../src/tickets/view";

// The Tickets page's rules (THE-2124): its address, its groups and their
// order, what its forms send, and its strings in both languages.

const ticket = (id: string, more: Partial<FoldedTicket> = {}): FoldedTicket => ({
  id,
  title: id,
  status: "backlog",
  labels: [],
  blockers: [],
  ...more,
});
const state = (more: Partial<FleetState>): FleetState => ({
  sessions: [],
  tickets: [],
  pullRequests: [],
  inbox: [],
  queue: [],
  validations: [],
  ...more,
});
const session = (ticket: string, phase: string, at = "2026-11-02T10:00:00.000Z") =>
  ({
    ticket,
    session: `s-${ticket}`,
    title: ticket,
    phase,
    state: phase === "merged" ? "merged" : phase === "blocked" ? "blocked" : "in-progress",
    reason: `${ticket} reason`,
    flowStep: "implementing",
    at,
  }) as FleetState["sessions"][number];

test("the page's address names the project, a ticket or the new ticket's form", () => {
  expect(routeOf("#/projects/orchard/tickets")).toEqual({ kind: "tickets", id: "orchard" });
  expect(routeOf("#/projects/orchard/tickets?ticket=ORCHA-3")).toEqual({
    kind: "tickets",
    id: "orchard",
    ticket: "ORCHA-3",
  });
  expect(routeOf("#/projects/orchard/tickets?new")).toEqual({ kind: "tickets", id: "orchard", creating: true });
  expect(ticketsHref("sea lane", { ticket: "SEA-1" })).toBe("#/projects/sea%20lane/tickets?ticket=SEA-1");
  expect(routeOf(ticketsHref("sea lane", "new"))).toEqual({ kind: "tickets", id: "sea lane", creating: true });
});

test("tickets fall in four groups: ready to launch, in flight, backlog, done newest first", () => {
  const rows = ticketRows(
    state({
      tickets: [
        ticket("ORCHA-1", { labels: ["ready-for-agent"] }),
        ticket("ORCHA-2", { labels: ["ready-for-agent", "parked"] }),
        ticket("ORCHA-3", { labels: ["ready-for-agent"], blockers: [{ id: "ORCHA-4", status: "started" }] }),
        ticket("ORCHA-4", { status: "started" }),
        ticket("ORCHA-5", { status: "completed" }),
        ticket("ORCHA-6", { status: "canceled" }),
        ticket("ORCHA-7", { status: "completed" }),
        ticket("ORCHA-8", { labels: ["ready-for-agent"], parent: "ORCHA-9" }),
        ticket("ORCHA-9", { labels: ["ready-for-agent"] }),
        ticket("ORCHA-10", { status: "unstarted", labels: ["ready-for-agent"] }),
        ticket("ORCHA-11", { labels: ["ready-for-agent"], blockers: undefined }),
        ticket("ORCHA-12", { labels: ["ready-for-agent"], phase: "released" }),
      ],
      sessions: [
        session("ORCHA-4", "blocked"),
        session("ORCHA-5", "merged", "2026-11-01T10:00:00.000Z"),
        session("ORCHA-7", "merged", "2026-11-02T10:00:00.000Z"),
      ],
      pullRequests: [{ number: 4, ticket: "ORCHA-10", state: "open", ci: "pending", conflicting: false }],
    }),
  );
  const ids = (group: keyof typeof rows) => rows[group].map((r) => r.ticket.id);
  expect(ids("ready")).toEqual(["ORCHA-1", "ORCHA-8"]);
  expect(ids("flight")).toEqual(["ORCHA-4"]);
  expect(rows.flight[0]?.tone).toBe("blocked");
  // Parked, waiting on a blocker, a parent, with an open pull request, no blocker evidence read
  // (the launch refuses it) or a phase left from an ended worker (the coordinator skips it): not ready.
  expect(ids("backlog")).toEqual(["ORCHA-2", "ORCHA-3", "ORCHA-9", "ORCHA-10", "ORCHA-11", "ORCHA-12"]);
  // The latest merge first, then the newest number.
  expect(ids("done")).toEqual(["ORCHA-7", "ORCHA-5", "ORCHA-6"]);
});

test("the forms send what they hold: a new ticket whole, an edit only what the owner changed", () => {
  expect(
    createFields({
      title: " Plant ",
      description: "Rows",
      labels: "web, ,web, ready-for-agent",
      parent: "",
      ready: true,
    }),
  ).toEqual({ title: "Plant", description: "Rows", labels: ["web"], ready: true });
  const opened = ticket("ORCHA-1", {
    title: "Plant",
    description: "Rows",
    labels: ["web", "ready-for-agent"],
    parent: "ORCHA-9",
  });
  const draft = draftOf(opened);
  expect(draft).toEqual({ title: "Plant", description: "Rows", labels: "web", parent: "ORCHA-9", ready: true });
  expect(updateFields(opened, draft)).toEqual({});
  // Labels go as added and removed ones, the ready label untouched; clearing the parent sends null.
  expect(updateFields(opened, { ...draft, labels: "api", parent: "" })).toEqual({
    addLabels: ["api"],
    removeLabels: ["web"],
    parent: null,
  });
  // Compared with the ticket as the form opened: only the description goes, whatever changed since.
  expect(updateFields(opened, { ...draft, description: "Rows and rows" })).toEqual({ description: "Rows and rows" });
});

test("the strings speak the viewer's language, French for a French tag first", () => {
  expect(languageOf(["fr-FR", "en-US"])).toBe("fr");
  expect(languageOf(["en-GB", "fr"])).toBe("en");
  expect(languageOf(["de-DE"])).toBe("en");
  expect(Object.keys(STRINGS.fr).sort()).toEqual(Object.keys(STRINGS.en).sort());
  expect(translate("en", "tickets.parent", { id: "ORCHA-2" })).toBe("Parent ORCHA-2");
  expect(translate("fr", "tickets.group.ready")).toBe("Prêts à lancer");
});

test("a write keeps its request id while the daemon has not answered, and only then", async () => {
  let n = 0;
  const write = requestWrites(() => `id-${++n}`);
  const ids: string[] = [];
  const fail = (code?: string) => (requestId: string) => {
    ids.push(requestId);
    return Promise.reject(Object.assign(new Error("no"), code ? { code } : {}));
  };
  const ok = (requestId: string) => {
    ids.push(requestId);
    return Promise.resolve(requestId);
  };
  // Dropped twice before an answer: the same write keeps its id, so the daemon writes it once.
  await write("create A", fail()).catch(() => {});
  await write("create A", fail()).catch(() => {});
  expect(await write("create A", ok)).toBe("id-1");
  // Confirmed: the same fields again are a new write.
  expect(await write("create A", ok)).toBe("id-2");
  // Refused (an error frame, with its code): the next attempt is a new call.
  await write("create B", fail("denied")).catch(() => {});
  await write("create B", ok);
  // Another write while one was dropped takes its own id.
  await write("create C", fail()).catch(() => {});
  await write("create D", ok);
  expect(ids).toEqual(["id-1", "id-1", "id-1", "id-2", "id-3", "id-4", "id-5", "id-6"]);
});

import { expect, test } from "bun:test";
import type { FleetState, FoldedTicket } from "../src/fleet/state";
import { languageOf, STRINGS, translate } from "../src/lib/i18n";
import { routeOf, ticketsHref } from "../src/lib/route";
import { createFields, draftOf, ticketRows, updateFields } from "../src/tickets/view";

// The Tickets page's rules (THE-2124): its address, its groups and their
// order, what its forms send, and its strings in both languages.

const ticket = (id: string, more: Partial<FoldedTicket> = {}): FoldedTicket => ({
  id,
  title: id,
  status: "backlog",
  labels: [],
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
  // Parked, waiting on a blocker, a parent, or with an open pull request: not ready.
  expect(ids("backlog")).toEqual(["ORCHA-2", "ORCHA-3", "ORCHA-9", "ORCHA-10"]);
  // The latest merge first, then the newest number.
  expect(ids("done")).toEqual(["ORCHA-7", "ORCHA-5", "ORCHA-6"]);
});

test("the forms send what they hold: a new ticket whole, an edit only what changed", () => {
  expect(
    createFields({
      title: " Plant ",
      description: "Rows",
      labels: "web, ,web, ready-for-agent",
      parent: "",
      ready: true,
    }),
  ).toEqual({ title: "Plant", description: "Rows", labels: ["web"], ready: true });
  const folded = ticket("ORCHA-1", {
    title: "Plant",
    description: "Rows",
    labels: ["web", "ready-for-agent"],
    parent: "ORCHA-9",
  });
  const draft = draftOf(folded);
  expect(draft).toEqual({ title: "Plant", description: "Rows", labels: "web", parent: "ORCHA-9", ready: true });
  expect(updateFields(folded, draft)).toEqual({});
  // An edit of the labels keeps the ticket ready; clearing the parent sends null.
  expect(updateFields(folded, { ...draft, labels: "web, api", parent: "" })).toEqual({
    labels: ["web", "api", "ready-for-agent"],
    parent: null,
  });
});

test("the strings speak the viewer's language, French for a French tag first", () => {
  expect(languageOf(["fr-FR", "en-US"])).toBe("fr");
  expect(languageOf(["en-GB", "fr"])).toBe("en");
  expect(languageOf(["de-DE"])).toBe("en");
  expect(Object.keys(STRINGS.fr).sort()).toEqual(Object.keys(STRINGS.en).sort());
  expect(translate("en", "tickets.parent", { id: "ORCHA-2" })).toBe("Parent ORCHA-2");
  expect(translate("fr", "tickets.group.ready")).toBe("Prêts à lancer");
});

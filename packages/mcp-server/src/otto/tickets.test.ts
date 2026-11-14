import { expect, test } from "bun:test";
import { ticketStates, validateTicketGraph } from "@armada/core";

const ticket = (id: string, dependencies: string[] = []) => ({
  id,
  outcome: "Inspect a result",
  criteria: [{ use: "Open the result", proof: "Visible result link" }],
  exclusions: ["Launching"],
  dependencies,
});
test("file ingestion preserves order and IDs, strips completion claims and derives conservative readiness", () => {
  const graph = validateTicketGraph({
    briefRevision: 1,
    tickets: [{ ...ticket("first"), state: "done" }, ticket("second", ["first"])],
  });
  expect(graph.tickets.map((t) => t.id)).toEqual(["first", "second"]);
  expect(ticketStates(graph).map((t) => t.state)).toEqual(["ready", "blocked"]);
  expect(graph.tickets[0]).not.toHaveProperty("state");
});
test("invalid graphs cannot introduce cycles, foreign edges or invalid criteria", () => {
  for (const tickets of [
    [ticket("a", ["b"]), ticket("b", ["a"])],
    [ticket("a", ["foreign"])],
    [ticket("a"), ticket("a")],
    [{ ...ticket("a"), criteria: [] }],
    [{ ...ticket("a"), criteria: Array(4).fill({ use: "Open", proof: "Link" }) }],
  ])
    expect(() => validateTicketGraph({ briefRevision: 1, tickets })).toThrow();
});

test("all blocking tickets need every criterion proved before releasing a dependent", () => {
  const graph = validateTicketGraph({
    briefRevision: 1,
    tickets: [
      {
        ...ticket("a"),
        criteria: [
          { use: "Open", proof: "Link" },
          { use: "Inspect", proof: "Artifact" },
        ],
      },
      ticket("b"),
      ticket("c", ["a", "b"]),
    ],
  });
  const proof = (ticketId: string, criterionIndex: number) => ({ ticketId, criterionIndex, factId: "observed_fact" });
  expect(ticketStates(graph, [proof("a", 0), proof("b", 0)]).map((t) => t.state)).toEqual(["ready", "done", "blocked"]);
  expect(ticketStates(graph, [proof("a", 0), proof("a", 1), proof("b", 0)]).map((t) => t.state)).toEqual([
    "done",
    "done",
    "ready",
  ]);
});

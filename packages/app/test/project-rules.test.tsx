import { expect, test } from "bun:test";
import { fold } from "@armada/daemon/fold";
import { PROTOCOL_VERSION } from "@armada/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { createDaemonClient, type SocketLike } from "../src/protocol/client";
import { ProjectRules } from "../src/rules/ProjectRules";

// Boundary proof: a real daemon fold -> subscription snapshot -> project's visible rules (the room's
// Rules tab, THE-2085, draws them from the same snapshot; test/room-panel.test.tsx opens it).
// Catches wrong-project reads, missing rule fields and confusing unset values with an uncapped policy.
test("a project's rules read from its own folded snapshot", () => {
  const tables = fold([
    {
      seq: 1,
      project: "orchard",
      kind: "coordinator.checkpoint",
      at: "2030-01-01T00:00:00.000Z",
      actor: "coordinator",
      payload: {
        checkpoint: {
          format: "armada.tools",
          version: 1,
          type: "rules",
          rules: {
            revision: 1,
            value: {
              routing: [
                { labels: ["backend"], cli: "claude", model: "oak", effort: "high" },
                { when: "Frontend work", cli: "codex", model: "sun" },
              ],
              defaultRoute: { cli: "opencode", model: "garden" },
              placement: { workers: "vm", coordinator: "local" },
              policy: { silenceMinutes: 12, quietMinutes: 40, maxWorkers: null },
            },
          },
        },
      },
    },
  ]);
  const socket: SocketLike = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null };
  const client = createDaemonClient({ url: "ws://daemon.test/", open: () => socket, schedule: () => () => {} });
  client.start();
  const say = (message: Record<string, unknown>) =>
    socket.onmessage?.({ data: JSON.stringify({ version: PROTOCOL_VERSION, ...message }) });
  say({
    type: "projects.result",
    id: "list",
    projects: [
      { id: "orchard", name: "Orchard", repository: "example/orchard" },
      { id: "field", name: "Field", repository: "example/field" },
    ],
  });
  const view = (id: string) => {
    const snapshot = client.getState().fleets[id];
    return snapshot ? renderToStaticMarkup(<ProjectRules state={snapshot.state} />) : "";
  };
  expect(view("orchard")).toBe("");
  say({
    type: "project.subscribed",
    id: "read",
    subscriptionId: "sub",
    project: "orchard",
    after: 0,
    snapshot: { seq: 1, state: tables.projects.orchard },
  });
  const html = view("orchard");
  for (const content of [
    "Revision 1",
    "backend",
    "claude",
    "oak",
    "high",
    "Frontend work",
    "codex",
    "sun",
    "opencode",
    "garden",
    "In a VM",
    "On this machine",
    "12 min",
    "40 min",
    "No cap",
  ])
    expect(html).toContain(content);
  expect(view("field")).not.toContain("oak");
  say({
    type: "project.subscribed",
    id: "empty",
    subscriptionId: "field",
    project: "field",
    after: 0,
    snapshot: { seq: 1, state: { rules: { revision: 0, value: {} } } },
  });
  const empty = view("field");
  expect(empty).toContain("No rules set yet");
  expect(empty).toContain("Not set");
  expect(empty).not.toContain("No cap");
  say({
    type: "events",
    subscriptionId: "sub",
    project: "orchard",
    seq: 2,
    events: [],
    snapshot: { seq: 2, state: { rules: { revision: 2, value: { policy: { maxWorkers: 4 } } } } },
  });
  const updated = view("orchard");
  expect(updated).toContain("Revision 2");
  expect(updated).toContain(">4</dd>");
  expect(updated).not.toContain("oak");
  client.stop();
});

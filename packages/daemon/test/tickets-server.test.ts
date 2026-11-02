import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { TrackerProvider } from "@armada/plugin-api";
import { type ServerMessage, serverMessageSchema, PROTOCOL_VERSION as version } from "@armada/protocol";
import { WebSocket } from "ws";
import pkg from "../../plugins/internal-tracker/package.json" with { type: "json" };
import { activate } from "../../plugins/internal-tracker/src/index.ts";
import { bootDaemon } from "../src/boot.ts";
import { startServer } from "../src/server/index.ts";
import type { EventStore } from "../src/store.ts";

// The Tickets page's writes (THE-2124) on the real server: the owner creates
// and edits an internal project's tickets through the coordinator's own ticket
// tools, a retry of one `requestId` replays its answer, and a read-only tracker
// refuses with the tool's line, as an `error` frame.

describe("ticket.create and ticket.update", { timeout: 4000 }, () => {
  let directory: string;
  let store: EventStore;
  let close: () => Promise<void>;
  let server: Awaited<ReturnType<typeof startServer>>;
  let ws: WebSocket;
  const replies = new Map<string, (frame: ServerMessage) => void>();
  let n = 0;
  const send = (message: Record<string, unknown>, minor = version.minor): Promise<ServerMessage> => {
    const id = `r${++n}`;
    const reply = new Promise<ServerMessage>((resolve) => replies.set(id, resolve));
    ws.send(JSON.stringify({ version: { ...version, minor }, id, ...message }));
    return reply;
  };
  const tickets = () => store.fold("orchard").projects.orchard?.tickets ?? [];

  before(
    async () => {
      directory = mkdtempSync(join(tmpdir(), "armada-tickets-server-"));
      const daemon = await bootDaemon({
        databasePath: join(directory, "events.sqlite"),
        configPath: join(directory, "config.json"),
        catalog: [{ id: "internal-tracker", manifest: pkg.armada, load: async () => ({ activate }) }],
        secrets: { get: async () => assert.fail("Internal tickets need no secrets") },
        log: { info() {}, error: (line) => assert.fail(line) },
      });
      store = daemon.store;
      const internal = daemon.registry.get("tracker", "internal");
      assert.ok(internal);
      const readerOnly: TrackerProvider = {
        read: async () => {},
        write: async () => assert.fail("Unsupported ticket mutations never call write"),
      };
      server = await startServer({
        store,
        projects: [
          { id: "orchard", name: "Orchard", repository: "example/orchard", tracker: "internal" },
          { id: "meadow", name: "Meadow", repository: "example/meadow", tracker: "reader-only", root: "MEAD-1" },
        ],
        trackerFor: (project) => (project === "orchard" ? internal : readerOnly),
      });
      close = async () => {
        await server.close();
        await daemon.close();
      };
      ws = new WebSocket(server.wsUrl);
      ws.on("message", (data) => {
        const frame = serverMessageSchema.parse(JSON.parse(String(data)));
        const id = "id" in frame ? frame.id : undefined;
        if (id) replies.get(id)?.(frame);
      });
      await once(ws, "open");
    },
    { timeout: 2000 },
  );
  after(
    async () => {
      ws?.terminate();
      await close?.();
      rmSync(directory, { recursive: true, force: true });
    },
    { timeout: 2000 },
  );

  const create = {
    type: "ticket.create",
    project: "orchard",
    requestId: "page-create-1",
    title: "Prune the pear trees",
    description: "Before **spring**.",
    labels: ["web"],
  };

  test("a create answers its id, written by the owner, and a retry replays it", async () => {
    const first = await send(create);
    assert.equal(first.type, "ticket.result");
    if (first.type !== "ticket.result") return;
    assert.equal(first.requestId, "page-create-1");
    assert.equal(first.ticket, "ORCHA-1");
    const created = store.readSince(0, "orchard").filter((e) => e.kind === "ticket.created");
    assert.equal(created.length, 1);
    assert.match(created[0]?.actor ?? "", /^owner:ticket:[0-9a-f]{64}$/);
    assert.deepEqual(
      tickets().map((t) => [t.id, t.title, t.labels, t.status]),
      [["ORCHA-1", "Prune the pear trees", ["web"], "backlog"]],
    );

    const again = await send(create);
    assert.equal(again.type === "ticket.result" && again.ticket, "ORCHA-1");
    assert.equal(store.readSince(0, "orchard").filter((e) => e.kind === "ticket.created").length, 1);

    const changed = await send({ ...create, title: "Prune the apple trees" });
    assert.equal(changed.type, "error");
    assert.equal(changed.type === "error" && changed.code, "denied");
    assert.match(changed.type === "error" ? changed.message : "", /different arguments/);
    assert.equal(tickets().length, 1);
  });

  test("an update marks the ticket ready, then cancels it", async () => {
    const created = await send({ ...create, requestId: "page-create-plums", title: "Water the plums", labels: [] });
    assert.equal(created.type, "ticket.result");
    const id = created.type === "ticket.result" ? created.ticket : "";
    const own = () => tickets().find((t) => t.id === id);
    assert.deepEqual(own()?.labels, []);

    const ready = await send({
      type: "ticket.update",
      project: "orchard",
      requestId: "page-ready-plums",
      ticket: id,
      addLabels: ["ready-for-agent"],
    });
    assert.equal(ready.type === "ticket.result" && ready.ticket, id);
    assert.deepEqual(own()?.labels, ["ready-for-agent"]);

    const canceled = await send({
      type: "ticket.update",
      project: "orchard",
      requestId: "page-cancel-plums",
      ticket: id,
      state: "canceled",
    });
    assert.equal(canceled.type, "ticket.result");
    assert.equal(own()?.status, "canceled");

    const missing = await send({
      type: "ticket.update",
      project: "orchard",
      requestId: "page-missing-1",
      ticket: "ORCHA-9",
      state: "canceled",
    });
    assert.equal(missing.type === "error" && missing.message, "ticket ORCHA-9 not found");
  });

  test("a tracker without create/update refuses with the tool's line, and writes nothing", async () => {
    const before = store.count;
    const refused = await send({ ...create, project: "meadow", requestId: "page-linear-1" });
    assert.equal(refused.type, "error");
    assert.equal(
      refused.type === "error" && refused.message,
      "the project's tracker cannot create tickets; write it in Linear",
    );
    assert.equal(store.count, before);
  });

  test("an app before minor 26 is refused before any write", async () => {
    const before = store.count;
    const old = await send({ ...create, requestId: "page-old-1" }, 25);
    assert.equal(old.type === "error" && old.code, "invalid-message");
    assert.equal(store.count, before);
  });
});

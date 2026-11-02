import { expect, test } from "bun:test";
import { admitRequest, PROTOCOL_VERSION as version } from "@armada/protocol";
import { type Io, run } from "../src/cli.ts";

test("tickets import addresses the daemon project without hosted config or credentials and prints final counts", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, message) {
        const body = JSON.parse(String(message));
        expect(admitRequest(body).ok).toBe(true);
        requests.push(body);
        if (body.type === "tracker.import")
          socket.send(
            JSON.stringify({
              version,
              type: "tracker.import.result",
              id: body.id,
              project: body.project,
              importId: "import-1",
            }),
          );
        if (body.type === "project.subscribe")
          socket.send(
            JSON.stringify({
              version,
              type: "project.subscribed",
              id: body.id,
              subscriptionId: "sub-1",
              project: body.project,
              after: 0,
              snapshot: {
                seq: 1,
                state: {
                  trackerImport: {
                    id: "import-1",
                    programRoot: "SEED-1",
                    state: "completed",
                    imported: 3,
                    skipped: 2,
                    total: 5,
                    comments: 4,
                  },
                },
              },
            }),
          );
      },
    },
  });
  let output = "";
  const io: Io = {
    cwd: "/no-checkout",
    env: { ARMADA_CONFIG: "/does-not-exist", ARMADA_DAEMON_URL: `http://127.0.0.1:${server.port}` },
    readFile: async () => {
      throw new Error("Import must not read checkout files or credentials");
    },
    ghToken: () => {
      throw new Error("Import must not read GitHub credentials");
    },
    stdout: (text) => {
      output += text;
    },
    stderr: () => {},
  };
  try {
    expect(await run(["tickets", "import", "SEED-1", "--project", "orchard"], io)).toBe(0);
    expect(requests[0]).toMatchObject({ type: "tracker.import", project: "orchard", programRoot: "SEED-1" });
    expect(output).toBe("Linear import SEED-1: completed; 3 imported, 2 skipped, 4 comments\n");
    // Non-loopback addresses are refused before attempting a connection.
    expect(
      await run(["tickets", "import", "SEED-1", "--project", "orchard", "--api-url", "https://remote.example"], io),
    ).toBe(2);
  } finally {
    server.stop(true);
  }
});

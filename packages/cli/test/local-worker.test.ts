import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, run } from "../src/cli.ts";

test("worker capability routes CLI commands to its Unix socket without V1 config or credentials, and fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-worker-cli-"));
  const socketPath = join(directory, "worker.sock");
  const token = randomBytes(32).toString("base64url");
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    requests.push(JSON.parse(body));
    res.writeHead(requests.at(-1)?.ticket === "SEED-1" ? 200 : 403, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  let output = "";
  let errors = "";
  const io: Io = {
    cwd: directory,
    env: { ARMADA_WORKER_SOCKET: socketPath, ARMADA_WORKER_TOKEN: token, ARMADA_TICKET: "SEED-1" },
    readFile: async () => {
      throw new Error("V1 file discovery must not run");
    },
    readStdin: async () => "Implement the seed feature",
    ghToken: () => {
      throw new Error("V1 credential discovery must not run");
    },
    stdout: (text) => {
      output += text;
    },
    stderr: (text) => {
      errors += text;
    },
  };
  try {
    for (const argv of [
      ["claim", "SEED-1"],
      ["report", "implementing", "--message", "Planting"],
      ["report", "implementing", "--plan-file", "-"],
      ["heartbeat"],
      ["ask", "Which seed?", "--options", "Oak | Pine"],
      ["release", "--reason", "Finished"],
    ])
      expect(await run(argv, io)).toBe(0);
    expect(requests.map((value) => value.command)).toEqual([
      "claim",
      "report",
      "report",
      "heartbeat",
      "ask",
      "release",
    ]);
    expect(requests[1]).toMatchObject({ ticket: "SEED-1", phase: "implementing", message: "Planting" });
    expect(requests[2]?.message).toContain("Implement the seed feature");
    expect(requests[4]?.question).toBe("Which seed?\n\nOptions: Oak | Pine");
    expect(await run(["ask", "--message", "Need data"], io)).toBe(0);
    expect(requests.at(-1)?.question).toBe("Need data");
    expect(await run(["ask", "--message-file", "-"], io)).toBe(0);
    expect(requests.at(-1)?.question).toBe("Implement the seed feature");
    expect(await run(["ask", "Need access", "--secret", "SAMPLE_TOKEN"], io)).toBe(0);
    expect(requests.at(-1)?.question).toContain("Missing secret SAMPLE_TOKEN: Need access");
    expect(requests.at(-1)?.question).toContain("Never paste its value into chat");
    const beforeInvalid = requests.length;
    expect(await run(["ask", "Twice", "--message", "Conflict"], io)).toBe(2);
    expect(await run(["ask", "Need access", "--secret", "ARMADA_TOKEN"], io)).toBe(2);
    expect(requests).toHaveLength(beforeInvalid);
    expect(await run(["claim", "SEED-2"], io)).toBe(1);
    expect(errors).toContain("authorization refused");
    expect(`${output}${errors}`).not.toContain(token);
    const before = requests.length;
    expect(await run(["heartbeat"], { ...io, env: { ARMADA_WORKER_SOCKET: socketPath } })).toBe(2);
    expect(requests).toHaveLength(before);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test("a local worker waits for a restarting daemon before connecting, but never retries an accepted refusal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-worker-reconnect-"));
  const socketPath = join(directory, "worker.sock");
  const token = randomBytes(32).toString("base64url");
  const requests: Record<string, unknown>[] = [];
  let allowed = true;
  let disconnect = false;
  let retries = 0;
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    requests.push(JSON.parse(data));
    if (disconnect) {
      disconnect = false;
      req.socket.destroy();
      return;
    }
    res.writeHead(allowed ? 200 : 403);
    res.end('{"ok":true}');
  });
  const io: Io = {
    cwd: directory,
    env: { ARMADA_WORKER_SOCKET: socketPath, ARMADA_WORKER_TOKEN: token, ARMADA_TICKET: "SEED-1" },
    readFile: async () => {
      throw new Error("V1 discovery must not run");
    },
    ghToken: () => {
      throw new Error("V1 credentials must not be read");
    },
    stdout: () => {},
    stderr: () => {},
    sleep: async (ms) => {
      expect(ms).toBe(500);
      retries++;
      if (!server.listening) await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    },
  };
  try {
    expect(await run(["ask", "Continue planting?"], io)).toBe(0);
    expect(retries).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ command: "ask", question: "Continue planting?", ticket: "SEED-1" });
    allowed = false;
    expect(await run(["heartbeat"], io)).toBe(1);
    expect(retries).toBe(1);
    expect(requests).toHaveLength(2);
    disconnect = true;
    expect(await run(["report", "implementing", "--message", "Working"], io)).toBe(1);
    expect(requests).toHaveLength(3);
    expect(retries).toBe(1);
    allowed = true;
    disconnect = true;
    expect(await run(["heartbeat"], io)).toBe(0);
    expect(requests).toHaveLength(5);
    expect(requests.slice(-2)).toEqual([
      { command: "heartbeat", ticket: "SEED-1" },
      { command: "heartbeat", ticket: "SEED-1" },
    ]);
    expect(retries).toBe(2);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test("heartbeat reconnects share one elapsed deadline and a partial authorization refusal is final", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-worker-deadline-"));
  const socketPath = join(directory, "worker.sock");
  let clock = 0;
  let requests = 0;
  let sleeps = 0;
  let refused = false;
  let refusalClosed: Promise<void> | undefined;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* Drain the request. */
    }
    requests++;
    if (refused) {
      refusalClosed = new Promise<void>((resolve) => req.socket.once("close", () => resolve()));
      res.writeHead(403);
      res.write('{"error":');
      // A rejected response must close without waiting for this body to end.
    } else {
      clock = Math.min(30_000, clock + 10_000);
      req.socket.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const io: Io = {
    cwd: directory,
    env: {
      ARMADA_WORKER_SOCKET: socketPath,
      ARMADA_WORKER_TOKEN: randomBytes(32).toString("base64url"),
      ARMADA_TICKET: "SEED-1",
    },
    now: () => new Date(clock),
    readFile: async () => {
      throw new Error("V1 discovery must not run");
    },
    ghToken: () => {
      throw new Error("V1 credentials must not be read");
    },
    stdout: () => {},
    stderr: () => {},
    sleep: async (ms) => {
      sleeps++;
      clock += ms;
    },
  };
  try {
    expect(await run(["heartbeat"], io)).toBe(1);
    expect(clock).toBe(30_000);
    expect(requests).toBe(3);
    expect(sleeps).toBe(2);
    refused = true;
    expect(await run(["heartbeat"], io)).toBe(1);
    expect(requests).toBe(4);
    expect(sleeps).toBe(2);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Rejected response socket stayed open")), 1000);
      void refusalClosed?.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  }
});

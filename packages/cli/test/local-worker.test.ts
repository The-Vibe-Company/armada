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

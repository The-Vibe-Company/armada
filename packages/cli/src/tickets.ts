import { randomUUID } from "node:crypto";
import { trackerImportSchema, PROTOCOL_VERSION as version } from "@armada/protocol";
import type { Io } from "./io.ts";
import { UsageError } from "./io.ts";

/** Owner loopback request; never reads hosted credentials, checkout config or worker tokens. */
export async function importTickets(io: Io, rest: string[], project: string | null, address?: string): Promise<number> {
  if (rest.length !== 2 || rest[0] !== "import" || !rest[1]?.trim() || !project)
    throw new UsageError("armada tickets import <program-root> --project <id>");
  const endpoint = address ?? io.env.ARMADA_DAEMON_URL;
  if (!endpoint)
    throw new UsageError("Set ARMADA_DAEMON_URL to the running daemon's loopback URL, or pass --api-url <url>");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new UsageError("The daemon URL must be a loopback HTTP or WebSocket URL");
  }
  if (
    !["http:", "ws:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new UsageError("The daemon URL must be a loopback HTTP or WebSocket URL");
  url.protocol = "ws:";
  const id = randomUUID();
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url);
    let importId: string | undefined;
    let settled = false;
    const finish = (error?: Error, code = 1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(code);
    };
    const timer = setTimeout(
      () =>
        finish(
          new UsageError("Import did not finish within 60 seconds; check its progress in the room before retrying"),
        ),
      60_000,
    );
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ version, id, type: "tracker.import", project, programRoot: rest[1] })),
    );
    socket.addEventListener("error", () =>
      finish(new UsageError("Cannot reach the Armada daemon; start the app and check ARMADA_DAEMON_URL")),
    );
    socket.addEventListener("close", () =>
      finish(new UsageError("Daemon connection closed; check import progress in the room before retrying")),
    );
    socket.addEventListener("message", (message) => {
      try {
        const frame = JSON.parse(String(message.data));
        if (frame.type === "error")
          return finish(
            new UsageError(typeof frame.message === "string" ? frame.message : "Daemon refused the import"),
          );
        if (frame.type === "tracker.import.result" && frame.id === id && frame.project === project) {
          importId = frame.importId;
          socket.send(JSON.stringify({ version, id: `${id}:progress`, type: "project.subscribe", project, after: 0 }));
        }
        const parsed = trackerImportSchema.safeParse(frame.snapshot?.state?.trackerImport);
        if (!parsed.success || parsed.data.id !== importId || parsed.data.state === "running") return;
        const result = parsed.data;
        io.stdout(
          `Linear import ${rest[1]}: ${result.state}; ${result.imported} imported, ${result.skipped} skipped, ${result.comments} comments${result.pausedUntil ? `; paused until ${result.pausedUntil}` : ""}${result.error ? `; ${result.error}` : ""}\n`,
        );
        finish(undefined, result.state === "completed" ? 0 : 1);
      } catch {
        finish(new UsageError("Invalid daemon import response; check progress in the room"));
      }
    });
  });
}

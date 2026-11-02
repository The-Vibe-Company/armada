import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { secretNameRefusal } from "@armada/core";
import type { WorkerTicketResult } from "../../daemon/src/workers/ticket.ts";
import type { Io } from "./io.ts";
import { UsageError } from "./io.ts";

class TransportUnavailable extends Error {}
class BeforeConnect extends TransportUnavailable {}
const commands = new Set(["ticket", "claim", "report", "heartbeat", "ask", "release"]);
interface Args {
  command: string;
  rest: string[];
  options: Record<string, string>;
  json?: boolean;
}

/** V2 capabilities never fall through to hosted/V1 credentials or repository config discovery. */
export async function localWorker(io: Io, args: Args): Promise<number | null> {
  if (!commands.has(args.command) || (!io.env.ARMADA_WORKER_SOCKET && !io.env.ARMADA_WORKER_TOKEN)) return null;
  const expected = args.command === "claim" || args.command === "report" ? 1 : 0;
  const optionalArgument = args.command === "ask" || args.command === "ticket";
  if (optionalArgument ? args.rest.length > 1 : args.rest.length !== expected)
    throw new UsageError(
      `local ${args.command} takes ${optionalArgument ? "at most one positional argument" : `${expected} positional arguments`}`,
    );
  const socketPath = io.env.ARMADA_WORKER_SOCKET;
  const token = io.env.ARMADA_WORKER_TOKEN;
  if (!socketPath || !token) throw new UsageError("local worker requires its issued socket and token");
  const ticket =
    args.options.ticket ??
    (args.command === "claim" || args.command === "ticket" ? args.rest[0] : undefined) ??
    io.env.ARMADA_TICKET;
  if (!ticket) throw new UsageError("local worker needs its ticket");
  const now = () => (io.now?.() ?? new Date()).getTime();
  const once = async (body: Record<string, unknown>, timeoutMs: number) => {
    return new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const resolve = (value: Record<string, unknown>) => {
        clearTimeout(timer);
        resolvePromise(value);
      };
      const reject = (error: Error) => {
        clearTimeout(timer);
        rejectPromise(error);
      };
      const req = request(
        {
          socketPath,
          path: "/worker",
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          const scopeRefusal = args.command === "ticket" && res.statusCode === 409;
          if (res.statusCode !== 200 && !scopeRefusal) {
            reject(new Error("Local worker authorization refused or generation ended"));
            res.on("error", () => {});
            res.destroy();
            return;
          }
          let output = "";
          let bytes = 0;
          const limit = args.command === "ticket" && !scopeRefusal ? 16 * 1024 * 1024 : 65536;
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > limit) {
              reject(
                new Error(
                  args.command === "ticket" ? "Local ticket response exceeds 16 MiB" : "Invalid local worker response",
                ),
              );
              req.destroy();
              return;
            }
            output += chunk;
          });
          res.on("end", () => {
            try {
              const result = JSON.parse(output);
              if (scopeRefusal) {
                const own = result.ticket;
                return reject(
                  new Error(
                    result.code === "ticket-scope" &&
                      typeof own === "string" &&
                      own.length <= 200 &&
                      !/[\r\n]/.test(own)
                      ? `your capability is for ${own}`
                      : "Local worker authorization refused or generation ended",
                  ),
                );
              }
              resolve(result);
            } catch {
              reject(new Error("Invalid local worker response"));
            }
          });
          res.on("error", () => reject(new TransportUnavailable("Local worker response unavailable")));
        },
      );
      let connected = false;
      req.on("socket", (socket) => {
        if (!socket.connecting) connected = true;
        socket.once("connect", () => {
          connected = true;
        });
      });
      timer = setTimeout(
        () => req.destroy(Object.assign(new Error("Local worker request timed out"), { code: "ETIMEDOUT" })),
        timeoutMs,
      );
      req.on("error", (error: NodeJS.ErrnoException) => {
        const message = "Local worker socket unavailable; no V1 request was made";
        reject(
          !connected && ["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")
            ? new BeforeConnect(message)
            : ["ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(error.code ?? "")
              ? new TransportUnavailable(message)
              : new Error(message),
        );
      });
      req.end(JSON.stringify({ ...body, ticket }));
    });
  };
  const call = async (body: Record<string, unknown>) => {
    // Only retry a connection that never reached a daemon. A refused capability or an unknown
    // write outcome must not be replayed. Heartbeats are idempotent and may reconnect after
    // a dropped response. The body (including an ask's identity) stays unchanged.
    const deadline = now() + 30_000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(body, Math.max(1, Math.min(10_000, deadline - now())));
      } catch (error) {
        const retryable =
          error instanceof BeforeConnect || (args.command === "heartbeat" && error instanceof TransportUnavailable);
        const remaining = deadline - now();
        if (!retryable || remaining <= 0 || attempt >= 60 || io.stopped?.()) throw error;
        await (io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(Math.min(500, remaining));
        if (now() >= deadline) throw error;
      }
    }
  };
  const readText = async (path: string) => {
    const content = path === "-" ? await io.readStdin?.() : await io.readFile(path);
    if (content == null) throw new UsageError("local worker input file is unavailable");
    return content;
  };
  let body: Record<string, unknown> = { command: args.command };
  if (args.command === "report") {
    let message = args.options.message ?? "";
    if (args.options["message-file"]) message = await readText(args.options["message-file"]);
    let plan = args.options.plan;
    if (args.options["plan-file"]) plan = await readText(args.options["plan-file"]);
    if (plan) message += `\n\nPlan:\n${plan}`;
    body = {
      ...body,
      phase: args.rest[0],
      message: message.trim(),
      ...(args.options.stage ? { stage: args.options.stage } : {}),
      ...(args.options.pr ? { pr: Number(/(?:^#?|\/pull\/)(\d+)$/.exec(args.options.pr)?.[1]) } : {}),
      ...(args.options.sha ? { sha: args.options.sha } : {}),
    };
  } else if (args.command === "ask") {
    if (args.options.message !== undefined && args.options["message-file"] !== undefined)
      throw new UsageError("give the question once: --message or --message-file");
    const fromOption =
      args.options["message-file"] !== undefined ? await readText(args.options["message-file"]) : args.options.message;
    if (args.rest[0] !== undefined && fromOption !== undefined)
      throw new UsageError("give the question once: argument, --message or --message-file");
    let question = args.rest[0] ?? fromOption;
    if (!question?.trim()) throw new UsageError("local ask needs a question");
    const secret = args.options.secret;
    if (secret !== undefined) {
      if (secretNameRefusal(secret)) throw new UsageError("--secret takes an upper snake case secret name");
      question = `Missing secret ${secret}: ${question}\nConfigure the secret for this worker locally, then relaunch. Never paste its value into chat.`;
    }
    if (args.options.options) question += `\n\nOptions: ${args.options.options}`;
    body = { ...body, question, key: randomUUID() };
  } else if (args.command === "release") body = { ...body, reason: args.options.reason };
  if (args.command === "heartbeat" && args.options.every) {
    const match = /^(\d+(?:\.\d+)?)(s|m)$/.exec(args.options.every);
    const ms = match ? Number(match[1]) * (match[2] === "m" ? 60000 : 1000) : 0;
    const parent = Number(args.options.parent);
    if (ms < 1000 || ms > 3600000 || !Number.isFinite(ms) || !Number.isSafeInteger(parent) || parent <= 1)
      throw new UsageError("local heartbeat needs --every 1s..60m and --parent <agent-pid>");
    if (args.options.background === "true") {
      const started = await io.startBackground?.([
        "heartbeat",
        "--ticket",
        ticket,
        "--every",
        args.options.every,
        "--parent",
        String(parent),
      ]);
      if (!started) throw new Error("Local background heartbeat unavailable; report manually");
      io.stdout("Local worker heartbeat running in the background.\n");
      return 0;
    }
    let ready = false;
    while (
      !io.stopped?.() &&
      (
        io.processAlive ??
        ((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
      )(parent)
    ) {
      try {
        await call(body);
      } catch (error) {
        if (!ready) io.backgroundReady?.(false);
        throw error;
      }
      if (!ready) {
        ready = true;
        io.backgroundReady?.(true);
      }
      await (io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(ms);
    }
    return 0;
  }
  const result = await call(body);
  if (args.command === "ticket") {
    const detail = result as unknown as WorkerTicketResult;
    if (!detail.ticket || typeof detail.ticket.title !== "string") throw new Error("Invalid local ticket response");
    io.stdout(args.json ? `${JSON.stringify(detail.ticket)}\n` : renderTicket(detail));
  } else
    io.stdout(args.json ? `${JSON.stringify(result)}\n` : `${ticket}: ${args.command} recorded by the local daemon.\n`);
  return 0;
}

function renderTicket({ ticket, parent, internal }: WorkerTicketResult): string {
  const lines = [
    `# ${ticket.id} — ${ticket.title}`,
    "",
    `State: ${ticket.status}`,
    `Labels: ${ticket.labels?.join(", ") || "none"}`,
    `Parent: ${parent ? `${parent.id} — ${parent.title} (${parent.status})` : ticket.parent ? `${ticket.parent} (state unavailable)` : "none"}`,
    `Blockers: ${ticket.blockers?.map((blocker) => `${blocker.id} (${blocker.status})`).join(", ") || "none"}`,
    "",
    "## Description",
    "",
    ticket.description ?? "",
    "",
    "## Comments",
    "",
  ];
  for (const comment of ticket.comments ?? [])
    lines.push(`### ${comment.author} — ${comment.at}`, "", comment.body, "");
  if (!internal && ticket.url) lines.push(`older comments are in Linear: [${ticket.id}](${ticket.url})`, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

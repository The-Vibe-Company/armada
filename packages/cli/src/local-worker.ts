import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { secretNameRefusal } from "@armada/core";
import type { Io } from "./io.ts";
import { UsageError } from "./io.ts";

const commands = new Set(["claim", "report", "heartbeat", "ask", "release"]);
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
  if (args.command === "ask" ? args.rest.length > 1 : args.rest.length !== expected)
    throw new UsageError(`local ${args.command} takes ${expected} positional arguments`);
  const socketPath = io.env.ARMADA_WORKER_SOCKET;
  const token = io.env.ARMADA_WORKER_TOKEN;
  if (!socketPath || !token) throw new UsageError("local worker requires its issued socket and token");
  const ticket = args.options.ticket ?? (args.command === "claim" ? args.rest[0] : undefined) ?? io.env.ARMADA_TICKET;
  if (!ticket) throw new UsageError("local worker needs its ticket");
  const call = async (body: Record<string, unknown>) => {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
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
          let output = "";
          res.on("data", (chunk) => {
            output += chunk;
            if (output.length > 65536) req.destroy(new Error("Invalid local worker response"));
          });
          res.on("end", () => {
            if (res.statusCode !== 200)
              return reject(new Error("Local worker authorization refused or generation ended"));
            try {
              resolve(JSON.parse(output));
            } catch {
              reject(new Error("Invalid local worker response"));
            }
          });
          res.on("error", () => reject(new Error("Local worker response unavailable")));
        },
      );
      req.setTimeout(10000, () => req.destroy(new Error("Local worker request timed out")));
      req.on("error", () => reject(new Error("Local worker socket unavailable; no V1 request was made")));
      req.end(JSON.stringify({ ...body, ticket }));
    });
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
  io.stdout(args.json ? `${JSON.stringify(result)}\n` : `${ticket}: ${args.command} recorded by the local daemon.\n`);
  return 0;
}

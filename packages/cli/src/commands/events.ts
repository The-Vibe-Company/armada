import { AuthError } from "@armada/auth";
import { GoldenError, isFinalPromptStatus, type PromptStatus, type ToolCall } from "@armada/core";
import type { ListResult, LogsInput, LogsResult } from "@armada/core/contract";
import { Armada, ArmadaError } from "@armada/sdk";
import { acceptedOptions, flag, parseArgs, single } from "../args.ts";
import { resolveSandboxId } from "../current-sandbox.ts";
import { authenticatedSession, createSdkCommandClient } from "../sdk-session.ts";
import { stripControl } from "../table.ts";
import type { Command } from "./command.ts";

const TERMINAL_STATUSES = new Set(["stopped", "failed", "deleted"]);

const events: Command["run"] = async (argv, { io, deps, auth }) => {
  const args = parseArgs(argv, ["--tail"], ["-f", "--follow"]);
  acceptedOptions(args, "events", ["-f", "--follow", "--tail", "--org", "--json"]);
  if (args.positionals.length > 1) throw new GoldenError("invalid_config", "Pass at most one sandbox ID.");
  const tail = single(args, "--tail");
  const limit = Number(tail);
  if (tail !== undefined && (!/^\d+$/.test(tail) || limit < 1 || limit > 1000))
    throw new GoldenError("invalid_config", "--tail must be between 1 and 1000.");
  const org = single(args, "--org");
  const follow = flag(args, "-f") || flag(args, "--follow");
  const json = flag(args, "--json");
  const apiIo = { ...auth, fetch: deps.fetch ?? auth.fetch };
  const client = await createSdkCommandClient(apiIo);
  const id = await resolveSandboxId(
    args.positionals[0],
    auth.env,
    deps.sandboxFile,
    org,
    client.sandboxes.list<ListResult>,
  );
  const base: LogsInput = { id, follow, ...(org === undefined ? {} : { org }) };
  const seen = new Set<string>();
  const emit = (event: LogsResult["events"][number]) => {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    io.out(`${json ? JSON.stringify(event) : eventText(event)}\n`);
  };
  let firstTail = tail !== undefined;
  let cursor: string | null = null;
  let triedSse = false;

  while (true) {
    const page: LogsResult = await client.sandboxes.logs<LogsResult>(
      { ...base, ...(firstTail ? { direction: "backward", limit } : {}), ...(cursor === null ? {} : { cursor }) },
      { signal: AbortSignal.timeout(600_000) },
    );
    for (const event of page.events) emit(event);
    const hasMore = !firstTail && page.hasMore;
    firstTail = false;
    const next: string | null = page.cursor ?? cursor;
    if (!follow || (!hasMore && page.settled)) return 0;
    if (hasMore && next === cursor)
      throw new AuthError("Armada events response has more events but did not advance its cursor.", "unavailable");
    cursor = next;
    if (!hasMore) {
      if (!triedSse) {
        triedSse = true;
        if (await streamLiveEvents(id, apiIo, emit)) return 0;
      }
      await (deps.sleep ?? Bun.sleep)(1000);
    }
  }
};

async function streamLiveEvents(
  sandbox: string,
  apiIo: Parameters<typeof authenticatedSession>[0],
  emit: (event: LogsResult["events"][number]) => void,
) {
  const session = await authenticatedSession(apiIo);
  const probeUrl = `${session.origin}/api/v1/events?${new URLSearchParams({ sandbox, cursor: "tail" })}`;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  try {
    let initial: Response | undefined;
    for (let attempt = 0; attempt < 2 && !initial; attempt++) {
      let res: Response;
      try {
        res = await apiIo.fetch(probeUrl, {
          method: "GET",
          headers: { accept: "text/event-stream", authorization: `Bearer ${session.token()}` },
          signal: controller.signal,
        });
      } catch {
        return false;
      }
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        if (attempt === 0 && session.renewToken) {
          await session.renewToken();
          continue;
        }
        throw new AuthError("Run armada login or update ARMADA_TOKEN.", "unauthorized");
      }
      const media = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (!res.ok || media !== "text/event-stream" || !res.body) {
        await res.body?.cancel().catch(() => {});
        return false;
      }
      initial = res;
    }
    if (!initial) return false;
    let first: Response | undefined = initial;
    const stream = new Armada({
      url: session.origin,
      token: session.token(),
      fetch: async (input, init) => {
        if (!first) return apiIo.fetch(input, init);
        const res = first;
        first = undefined;
        return res;
      },
    }).events.stream({ sandbox, cursor: "tail" }, { signal: controller.signal });
    for await (const frame of stream) {
      if (frame.kind === "runtime_event" && frame.event) {
        emit(frame.event);
        if (
          frame.event.kind === "prompt" &&
          typeof frame.event.status === "string" &&
          isFinalPromptStatus(frame.event.status as PromptStatus)
        )
          return true;
      } else if (frame.kind === "transition" && frame.status && TERMINAL_STATUSES.has(frame.status)) return true;
    }
    return true;
  } catch (error) {
    if (error instanceof ArmadaError && error.status === 401)
      throw new AuthError("Run armada login or update ARMADA_TOKEN.", "unauthorized");
    return false;
  } finally {
    process.removeListener("SIGINT", stop);
    controller.abort();
  }
}

function summarize(value: unknown, max = 160) {
  if (value === undefined || value === null) return "";
  let raw: string;
  if (typeof value === "string") raw = value;
  else if (typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    const key = ["command", "file_path", "path", "pattern", "query", "url", "output", "text", "message"].find(
      (k) => typeof rec[k] === "string" && rec[k],
    );
    raw = key ? String(rec[key]) : JSON.stringify(value);
  } else raw = JSON.stringify(value);
  const clean = stripControl(raw).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function formatTool(tool: ToolCall, fallback: string, forceResult: boolean) {
  if (forceResult || tool.result !== undefined || tool.name === "tool_result") {
    const tag = `${tool.name && tool.name !== "tool_result" ? ` ${tool.name}` : ""}${tool.result?.isError ? " error" : ""}`;
    const body = summarize(tool.result?.output ?? fallback);
    return `[tool_result${tag}]${body ? ` ${body}` : ""}`;
  }
  const body = summarize(tool.input);
  return `[tool ${tool.server ? `${tool.server}/${tool.name}` : tool.name}]${body ? ` ${body}` : ""}`;
}

function eventText(event: LogsResult["events"][number]) {
  if (event.kind === "prompt" || event.kind === "steer") return String(event.text ?? "");
  if (event.kind === "message") {
    const text = typeof event.text === "string" ? event.text : "";
    const tools = Array.isArray(event.tools) ? (event.tools as ToolCall[]) : [];
    const isResult = event.responseKind === "tool_result";
    if (tools.length) {
      const lines = tools.map((t) => formatTool(t, text, isResult));
      return !isResult && text.trim() ? `${text}\n${lines.join("\n")}` : lines.join("\n");
    }
    return isResult ? `[tool_result]${summarize(text) ? ` ${summarize(text)}` : ""}` : text;
  }
  if (event.kind === "other" && event.data && typeof event.data === "object") {
    const data = event.data as Record<string, unknown>;
    if (event.type === "armada/modelRateLimit" && typeof data.message === "string")
      return `${data.message} (retry ${data.retryCount}, total wait ${Number(data.totalWaitMs) / 1000} s)`;
    if (event.type === "tool_use") {
      const body = summarize(data.input ?? data.arguments ?? data);
      return `[tool ${typeof data.name === "string" ? data.name : "tool"}]${body ? ` ${body}` : ""}`;
    }
    if (event.type === "tool_result") {
      const tag = `${typeof data.name === "string" && data.name !== "tool_result" ? ` ${data.name}` : ""}${data.isError === true || data.is_error === true ? " error" : ""}`;
      const body = summarize(data.output ?? data.content ?? data.result ?? data);
      return `[tool_result${tag}]${body ? ` ${body}` : ""}`;
    }
  }
  return JSON.stringify(event);
}

const usage = "armada events [sandbox-id] [-f] [--tail N] [--org UUID] [--json]";

export default {
  name: "events",
  summary: "Read agent events from a sandbox",
  usage: {
    interactive: `  ${usage}
                                           Read or follow (-f) agent events`,
  },
  help: `Usage: ${usage}
Read one page of agent events. --tail N starts with the last N events (1–1000).
-f follows new events until the sandbox settles. Ctrl-C stops the reader.
Piped output and --json emit one JSON object per event.
`,
  automaticJson: true,
  useSelectedOrg: true,
  validateProfileForHelp: true,
  run: events,
} satisfies Command;

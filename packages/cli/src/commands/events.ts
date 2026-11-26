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
    const key = JSON.stringify(event);
    if (seen.has(key)) return;
    seen.add(key);
    io.out(`${json ? key : eventText(event)}\n`);
  };
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (follow) process.once("SIGINT", stop);
  let preopenedSse: { response: Response; session: Awaited<ReturnType<typeof authenticatedSession>> } | undefined;
  try {
    if (follow) preopenedSse = await probeSse(id, apiIo, controller.signal);
    if (controller.signal.aborted) return 0;
    let firstTail = tail !== undefined;
    let cursor: string | null = null;

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
        if (preopenedSse) {
          const live = preopenedSse;
          preopenedSse = undefined;
          if (await consumeLiveEvents(id, apiIo, live, emit, controller.signal)) return 0;
        }
        if (controller.signal.aborted) return 0;
        await (deps.sleep ?? Bun.sleep)(1000);
      }
    }
  } finally {
    if (follow) process.removeListener("SIGINT", stop);
    await preopenedSse?.response.body?.cancel().catch(() => {});
    controller.abort();
  }
};

async function probeSse(sandbox: string, apiIo: Parameters<typeof authenticatedSession>[0], signal: AbortSignal) {
  const session = await authenticatedSession(apiIo);
  const probeUrl = `${session.origin}/api/v1/events?${new URLSearchParams({ sandbox, cursor: "tail" })}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await apiIo.fetch(probeUrl, {
        method: "GET",
        redirect: "error",
        headers: { accept: "text/event-stream", authorization: `Bearer ${session.token()}` },
        signal,
      });
    } catch {
      return undefined;
    }
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      if (attempt === 0 && session.renewToken) {
        await session.renewToken(signal);
        continue;
      }
      throw new AuthError("Run armada login or update ARMADA_TOKEN.", "unauthorized");
    }
    const media = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!res.ok || media !== "text/event-stream" || !res.body) {
      await res.body?.cancel().catch(() => {});
      return undefined;
    }
    return { response: res, session };
  }
  return undefined;
}

async function consumeLiveEvents(
  sandbox: string,
  apiIo: Parameters<typeof authenticatedSession>[0],
  live: { response: Response; session: Awaited<ReturnType<typeof authenticatedSession>> },
  emit: (event: LogsResult["events"][number]) => void,
  signal: AbortSignal,
) {
  let first: Response | undefined = live.response;
  const { session } = live;
  try {
    const stream = new Armada({
      url: session.origin,
      token: session.token(),
      fetch: async (input, init) => {
        if (first) {
          const res = first;
          first = undefined;
          return res;
        }
        const send = () => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${session.token()}`);
          return apiIo.fetch(input, { ...init, redirect: "error", headers });
        };
        const res = await send();
        if (res.status === 401 && session.renewToken) {
          await res.body?.cancel().catch(() => {});
          await session.renewToken(signal);
          return send();
        }
        return res;
      },
    }).events.stream({ sandbox, cursor: "tail" }, { signal, timeoutMs: 2_147_483_647 });
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
    if (signal.aborted) return true;
    if (error instanceof ArmadaError && error.status === 401)
      throw new AuthError("Run armada login or update ARMADA_TOKEN.", "unauthorized");
    return false;
  } finally {
    await first?.body?.cancel().catch(() => {});
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

function safeLabel(value: string) {
  return stripControl(value).replace(/\s+/g, " ").trim();
}

function formatTool(tool: ToolCall, fallback: string, forceResult: boolean) {
  const toolName = safeLabel(tool.name);
  if (forceResult || tool.result !== undefined || tool.name === "tool_result") {
    const tag = `${toolName && toolName !== "tool_result" ? ` ${toolName}` : ""}${tool.result?.isError ? " error" : ""}`;
    const body = summarize(tool.result?.output ?? fallback);
    return `[tool_result${tag}]${body ? ` ${body}` : ""}`;
  }
  const body = summarize(tool.input);
  const fullName = tool.server ? `${safeLabel(tool.server)}/${toolName}` : toolName;
  return `[tool ${fullName}]${body ? ` ${body}` : ""}`;
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
    if (isResult) {
      const body = summarize(text);
      return `[tool_result]${body ? ` ${body}` : ""}`;
    }
    return text;
  }
  if (event.kind === "other" && event.data && typeof event.data === "object") {
    const data = event.data as Record<string, unknown>;
    if (event.type === "armada/modelRateLimit" && typeof data.message === "string")
      return `${data.message} (retry ${data.retryCount}, total wait ${Number(data.totalWaitMs) / 1000} s)`;
    if (event.type === "tool_use") {
      const body = summarize(data.input ?? data.arguments ?? data);
      const name = typeof data.name === "string" ? safeLabel(data.name) : "tool";
      return `[tool ${name || "tool"}]${body ? ` ${body}` : ""}`;
    }
    if (event.type === "tool_result") {
      const name = typeof data.name === "string" ? safeLabel(data.name) : "";
      const tag = `${name && name !== "tool_result" ? ` ${name}` : ""}${data.isError === true || data.is_error === true ? " error" : ""}`;
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

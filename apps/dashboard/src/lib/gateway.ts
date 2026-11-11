import { VERSION } from "@armada/core";
import { describeFailure } from "./failure.ts";
import type { SendArgs } from "./model-choice.ts";

/**
 * The dashboard reads live logs and stops or messages a sandbox through the Armada MCP server:
 * only the server holds the boat.dev key, and the user JWT cannot read it. It calls the tools
 * named in the spec (`logs`, `send`, `stop`) over MCP Streamable HTTP, with the user's session token.
 */
export class GatewayError extends Error {
  override readonly name = "GatewayError";
  readonly status: number | undefined;
  /** The tool's typed failure (`error code: <code>` in its result), such as `credential_binding_required`. */
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type Gateway = {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
};

type Options = {
  url: string;
  token: string;
  fetch?: typeof fetch;
};

const PROTOCOL_VERSION = "2025-06-18";

export function createGateway(options: Options): Gateway {
  const doFetch = options.fetch ?? fetch;
  let nextId = 1;

  async function post(body: unknown, sessionId: string | null) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${options.token}`,
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    let response: Response;
    try {
      response = await doFetch(options.url, { method: "POST", headers, body: JSON.stringify(body), cache: "no-store" });
    } catch {
      throw new GatewayError("The Armada server is unreachable.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new GatewayError("The Armada server refused this session. Sign in again.", response.status);
    }
    if (!response.ok) throw new GatewayError(`The Armada server answered ${response.status}.`, response.status);
    return response;
  }

  return {
    async call(tool, args) {
      const init = await post(
        {
          jsonrpc: "2.0",
          id: nextId++,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "armada-dashboard", version: VERSION },
          },
        },
        null,
      );
      const sessionId = init.headers.get("mcp-session-id");
      await readMessage(init);
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);

      const id = nextId++;
      const response = await post(
        { jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } },
        sessionId,
      );
      const message = await readMessage(response, id);
      if (isRecord(message.error)) throw toolError(String(message.error.message ?? "The call failed."), undefined);
      const result = isRecord(message.result) ? message.result : {};
      const payload = extractPayload(result);
      if (result.isError === true)
        throw toolError(typeof payload === "string" ? payload : JSON.stringify(payload), errorCode(result));
      return payload;
    },
  };
}

function toolError(text: string, code: string | undefined): GatewayError {
  return new GatewayError(describeFailure(code)?.hint ?? text, undefined, code);
}

/** The server adds its typed failure as a separate text part: `error code: <code>`. */
function errorCode(result: Record<string, unknown>): string | undefined {
  const content = Array.isArray(result.content) ? result.content : [];
  for (const part of content) {
    if (!isRecord(part) || typeof part.text !== "string") continue;
    const match = /^error code: ([a-z_]+)$/.exec(part.text.trim());
    if (match) return match[1];
  }
  return undefined;
}

function extractPayload(result: Record<string, unknown>): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find((part) => isRecord(part) && part.type === "text" && typeof part.text === "string");
  if (!isRecord(text) || typeof text.text !== "string") return null;
  try {
    return JSON.parse(text.text);
  } catch {
    return text.text;
  }
}

/** A JSON-RPC reply comes as plain JSON or as a server-sent event stream; read the one for `id` (or the first). */
async function readMessage(response: Response, id?: number): Promise<Record<string, unknown>> {
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const messages: unknown[] = [];
  if (type.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {}
    }
  } else if (text.trim()) {
    try {
      messages.push(JSON.parse(text));
    } catch {
      throw new GatewayError("The Armada server sent something unreadable.");
    }
  }
  const records = messages.filter(isRecord);
  const match = id === undefined ? records[0] : records.find((message) => message.id === id);
  if (!match) throw new GatewayError("The Armada server sent no answer.");
  return match;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the dashboard asks of the server, by the tool names of the spec. `send` opens a new turn, `steer` redirects
 * the running one and `interrupt` stops it: the server applies the harness's capabilities, never the dashboard.
 */
export function sandboxGateway(gateway: Gateway) {
  const conversation = (id?: string) => (id ? { conversation_id: id } : {});
  return {
    logs: (sandboxId: string, since?: string | null, read: { all?: true; limit?: number } = {}) =>
      gateway.call("logs", { id: sandboxId, ...(since ? { since_cursor: since } : {}), ...read }),
    status: (sandboxId: string) => gateway.call("status", { id: sandboxId }),
    stop: (sandboxId: string) => gateway.call("stop", { id: sandboxId }),
    send: (sandboxId: string, prompt: string, override: SendArgs = {}, conversationId?: string) =>
      gateway.call("send", { id: sandboxId, prompt, ...conversation(conversationId), ...override }),
    steer: (sandboxId: string, text: string, conversationId?: string) =>
      gateway.call("steer", { id: sandboxId, text, ...conversation(conversationId) }),
    interrupt: (sandboxId: string, conversationId?: string) =>
      gateway.call("interrupt", { id: sandboxId, ...conversation(conversationId) }),
  };
}

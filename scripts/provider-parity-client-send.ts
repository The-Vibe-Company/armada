import { createGateway, GatewayError, sandboxGateway } from "../apps/dashboard/src/lib/gateway.ts";
import { ArmadaApiError, createArmadaApiClient } from "../packages/cli/src/armada-api.ts";
import { operation } from "../packages/cli/src/operations.ts";

export type SendClient = "dashboard" | "cli";
export class ClientSendError extends Error {
  constructor(
    readonly client: SendClient,
    readonly code: string,
    readonly httpStatus?: number,
  ) {
    super(code);
  }
}
interface Io {
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  sleep(ms: number): Promise<void>;
  until: number;
  verified(client: SendClient): void;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Exercise the production dashboard MCP and CLI send paths, not hand-copied payloads. */
export async function probeClientSend(
  input: { id: string; org: string; origin: string; token: string; conversationId: string },
  io: Io,
) {
  let client: SendClient = "dashboard";
  let expired = false;
  function fail(code: string): never {
    throw new ClientSendError(client, code);
  }
  const relay = async (raw: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url);
    if (
      url.origin !== input.origin ||
      url.search ||
      url.hash ||
      !["/mcp", "/api/v1/sandbox/send", "/api/v1/logs/read"].includes(url.pathname) ||
      init?.method !== "POST"
    )
      fail("client_send_unexpected_request");
    const remaining = io.until - io.now();
    if (remaining <= 0) {
      expired = true;
      fail("client_send_timeout");
    }
    const signal = AbortSignal.timeout(Math.max(1, Math.min(110_000, remaining)));
    const result = await io.fetch(url.href, {
      ...init,
      redirect: "error",
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
    if (io.now() > io.until) {
      expired = true;
      fail("client_send_timeout");
    }
    return result;
  };
  let output = "";
  const noSession = async (): Promise<never> => fail("client_send_session_fallback");
  const auth = {
    env: { ARMADA_URL: input.origin, ARMADA_TOKEN: input.token },
    fetch: relay,
    session: { read: noSession, write: noSession, clear: noSession },
    now: () => new Date(io.now()),
    open: () => fail("client_send_session_fallback"),
    out: (text: string) => {
      output += text;
      if (output.length > 262144) fail("invalid_client_send_receipt");
    },
    err: () => {},
  };
  const api = await createArmadaApiClient(auth);
  const dashboard = sandboxGateway(
    createGateway({ url: `${input.origin}/mcp`, token: input.token, fetch: relay as typeof fetch }),
  );
  for (const selected of ["dashboard", "cli"] as const) {
    client = selected;
    try {
      const marker = `PARITY_CLIENT_${client.toUpperCase()}_${crypto.randomUUID()}`;
      const prompt = `Reply with exactly ${marker} and nothing else. Do not use tools or change files.`;
      const requestId = crypto.randomUUID();
      let receipt: unknown;
      if (client === "dashboard") receipt = await dashboard.send(input.id, prompt, {}, input.conversationId, requestId);
      else {
        output = "";
        const result = await operation(
          "send",
          [
            input.id,
            prompt,
            "--org",
            input.org,
            "--conversation",
            input.conversationId,
            "--request-id",
            requestId,
            "--json",
          ],
          auth,
          async () => fail("client_send_file_read"),
        );
        if (result !== 0) fail("invalid_client_send_receipt");
        try {
          receipt = JSON.parse(output);
        } catch {
          fail("invalid_client_send_receipt");
        }
      }
      const promptId = object(receipt).promptId;
      if (typeof promptId !== "string" || !promptId) fail("invalid_client_send_receipt");
      let cursor: string | undefined,
        lastParent: string | undefined,
        finished = false,
        done = false;
      const messages = new Map<string, { text: string; eligible: boolean }>();
      for (let reads = 0; reads < 110 && io.now() < io.until; reads++) {
        const page = await api.request<{
          cursor?: string;
          hasMore?: boolean;
          events?: Array<{
            id?: string;
            messageId?: string;
            textMode?: string;
            kind?: string;
            promptId?: string;
            status?: string;
            text?: string;
            partial?: boolean;
            parentToolUseId?: string;
            responseKind?: string;
            retracted?: boolean;
          }>;
        }>("/api/v1/logs/read", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            org: input.org,
            id: input.id,
            coalesce: true,
            limit: 200,
            maxBytes: 262144,
            ...(cursor ? { cursor } : {}),
          }),
        });
        if (io.now() > io.until) fail("client_send_timeout");
        if (!Array.isArray(page?.events)) fail("invalid_client_send_receipt");
        cursor = page.cursor;
        for (const event of page.events) {
          if (event.promptId !== promptId) continue;
          if (event.kind === "prompt") {
            if (["failed", "interrupted"].includes(event.status ?? "")) fail("client_send_turn_failed");
            finished ||= event.status === "finished";
          }
          if (event.kind !== "message") continue;
          if (typeof event.id !== "string") fail("invalid_client_send_receipt");
          const key = event.messageId ?? event.id;
          if (!event.parentToolUseId && event.responseKind !== "tool_result") lastParent = key;
          const text =
            event.textMode === "delta" ? (messages.get(key)?.text ?? "") + (event.text ?? "") : (event.text ?? "");
          messages.set(key, {
            text: text.slice(0, 4096),
            eligible:
              text.length <= 4096 &&
              event.partial === false &&
              !event.parentToolUseId &&
              event.responseKind !== "tool_result" &&
              !event.retracted,
          });
        }
        const answer = lastParent ? messages.get(lastParent) : undefined;
        if (page.hasMore !== true && finished && answer?.eligible && answer.text.trim() === marker) {
          done = true;
          break;
        }
        await io.sleep(Math.min(1000, Math.max(0, io.until - io.now())));
      }
      if (!done) fail("client_send_timeout");
      io.verified(client);
    } catch (error) {
      if (error instanceof ClientSendError) throw error;
      if (expired || io.now() >= io.until) fail("client_send_timeout");
      const code =
        error instanceof ArmadaApiError ? error.serverCode : error instanceof GatewayError ? error.code : undefined;
      const status = error instanceof ArmadaApiError || error instanceof GatewayError ? error.status : undefined;
      throw new ClientSendError(
        client,
        typeof code === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(code)
          ? code
          : status === 401
            ? "unauthorized"
            : status === 403
              ? "forbidden"
              : "client_send_failed",
        status,
      );
    }
  }
}

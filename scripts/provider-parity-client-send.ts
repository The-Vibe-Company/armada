import { createParityClients, type ProofClient } from "./provider-parity-clients.ts";

export type { ProofClient as SendClient } from "./provider-parity-clients.ts";
export { ClientProofError as ClientSendError } from "./provider-parity-clients.ts";

interface Io {
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  sleep(ms: number): Promise<void>;
  until: number;
  verified(client: ProofClient): void;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
/** Exercise the production dashboard MCP and CLI send paths, not hand-copied payloads. */
export async function probeClientSend(
  input: { id: string; org: string; origin: string; token: string; conversationId: string },
  io: Io,
) {
  const session = await createParityClients(input, io, "send");
  const fail: (code: string) => never = session.fail;
  for (const selected of ["dashboard", "cli"] as const) {
    await session.run(selected, async () => {
      const client = selected;
      const marker = `PARITY_CLIENT_${client.toUpperCase()}_${crypto.randomUUID()}`;
      const prompt = `Reply with exactly ${marker} and nothing else. Do not use tools or change files.`;
      const requestId = crypto.randomUUID();
      let receipt: unknown;
      if (client === "dashboard") receipt = await session.dashboard.send(input.id, prompt, {}, requestId);
      else {
        receipt = await session.command([
          input.id,
          prompt,
          "--org",
          input.org,
          "--conversation",
          input.conversationId,
          "--request-id",
          requestId,
          "--json",
        ]);
      }
      const promptId = object(receipt).promptId;
      if (typeof promptId !== "string" || !promptId) fail("invalid_client_send_receipt");
      let cursor: string | undefined,
        lastParent: string | undefined,
        finished = false,
        done = false;
      const messages = new Map<string, { text: string; eligible: boolean }>();
      for (let reads = 0; reads < 110 && io.now() < io.until; reads++) {
        const page = await session.api.request<{
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
    });
  }
}

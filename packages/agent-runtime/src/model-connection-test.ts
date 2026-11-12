import {
  type ClaudeEndpoint,
  type CodexEndpoint,
  type ModelConnectionTestResult,
  modelConnectionErrorCode,
  parseClaudeEndpoint,
  parseCodexEndpoint,
  resolveModelChoice,
} from "@armada/core";
import { bounded } from "./deadline.ts";

export type BoundModelConnection =
  | { harness: "codex"; endpoint: CodexEndpoint; apiKey: string }
  | { harness: "claude"; endpoint: ClaudeEndpoint; apiKey: string };
export type { ModelConnectionTestResult } from "@armada/core";

/** One bounded native-wire request using the runtime's bound connection, never RPC-supplied credentials. */
export async function testModelConnection(
  connection: BoundModelConnection,
  model: string,
  signal: AbortSignal,
  fetcher: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch> = fetch,
): Promise<ModelConnectionTestResult> {
  resolveModelChoice(connection.harness, { model });
  if (!connection.apiKey) throw Error("model_connection_test_denied");
  const endpoint =
    connection.harness === "codex" ? parseCodexEndpoint(connection.endpoint) : parseClaudeEndpoint(connection.endpoint);
  const url = new URL(endpoint.baseUrl + (connection.harness === "codex" ? "/responses" : "/v1/messages"));
  if (connection.harness === "codex" && "apiVersion" in endpoint && endpoint.apiVersion)
    url.searchParams.set("api-version", endpoint.apiVersion);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (connection.harness === "codex" || ("auth" in endpoint && endpoint.auth === "bearer"))
    headers.authorization = `Bearer ${connection.apiKey}`;
  else headers["x-api-key"] = connection.apiKey;
  if (connection.harness === "claude") headers["anthropic-version"] = "2023-06-01";
  const controller = new AbortController();
  const abort = AbortSignal.any([signal, controller.signal]);
  let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel"> | undefined;
  try {
    return await bounded(
      (async () => {
        abort.throwIfAborted();
        const response = await fetcher(url, {
          method: "POST",
          headers,
          redirect: "error",
          signal: abort,
          body: JSON.stringify(
            connection.harness === "codex"
              ? { model, input: ".", max_output_tokens: 16, store: false }
              : { model, max_tokens: 1, messages: [{ role: "user", content: "." }] },
          ),
        });
        reader = response.body?.getReader();
        let bytes = 0;
        let text = "";
        const decoder = new TextDecoder();
        while (reader) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 16384) return { ok: false, status: response.status, error: "invalid_response", code: null };
          text += decoder.decode(chunk.value, { stream: true });
        }
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text + decoder.decode());
        } catch {
          /* Status is still useful for a non-JSON rejection. */
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
        const failure = body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : {};
        const rawCode = failure.code ?? failure.type;
        const code = rawCode !== connection.apiKey ? modelConnectionErrorCode(rawCode) : null;
        if (!response.ok || body.status === "failed" || body.type === "error")
          return { ok: false, status: response.status, error: "provider_rejected", code };
        const valid =
          typeof body.id === "string" &&
          (connection.harness === "codex"
            ? body.object === "response" && ["completed", "incomplete"].includes(String(body.status))
            : body.type === "message" && body.role === "assistant" && Array.isArray(body.content));
        return { ok: valid, status: response.status, error: valid ? null : "invalid_response", code: null };
      })(),
      15000,
    );
  } catch {
    return { ok: false, status: null, error: "connection_failed", code: null };
  } finally {
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

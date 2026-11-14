import {
  type ClaudeEndpoint,
  type CodexEndpoint,
  type ModelConnectionTestResult,
  modelConnectionErrorCode,
  OPENCODE_CONNECTION_PROVIDER,
  type OpenCodeEndpoint,
  parseClaudeEndpoint,
  parseCodexEndpoint,
  parseOpenCodeEndpoint,
  resolveModelChoice,
} from "@armada/core";
import { bounded } from "./deadline.ts";

export type BoundModelConnection =
  | { harness: "codex"; endpoint: CodexEndpoint; apiKey: string }
  | { harness: "claude"; endpoint: ClaudeEndpoint; apiKey: string }
  | { harness: "opencode"; endpoint: OpenCodeEndpoint; apiKey: string };
export type { ModelConnectionTestResult } from "@armada/core";

/** Resolve only runtime-owned API-key credentials; subscription OAuth is not a model API key. */
export function runtimeModelConnection(
  harness: "claude" | "codex",
  env: Record<string, string>,
  codexEndpoint?: CodexEndpoint,
): BoundModelConnection | null {
  if (harness === "codex")
    return env.OPENAI_API_KEY
      ? {
          harness,
          endpoint: codexEndpoint ?? { version: 1, baseUrl: "https://api.openai.com/v1" },
          apiKey: env.OPENAI_API_KEY,
        }
      : null;
  const apiKey = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY;
  return apiKey
    ? {
        harness,
        endpoint: {
          version: 1,
          baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
          auth: env.ANTHROPIC_AUTH_TOKEN ? "bearer" : "api-key",
        },
        apiKey,
      }
    : null;
}

/** One bounded native-wire check. Callers own authorization and network destination admission. */
export async function testModelConnection(
  connection: BoundModelConnection,
  model: string,
  signal: AbortSignal,
  fetcher: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch> = fetch,
): Promise<ModelConnectionTestResult> {
  resolveModelChoice(connection.harness, { model });
  if (!connection.apiKey) throw Error("model_connection_test_denied");
  const endpoint =
    connection.harness === "codex"
      ? parseCodexEndpoint(connection.endpoint)
      : connection.harness === "opencode"
        ? parseOpenCodeEndpoint(connection.endpoint)
        : parseClaudeEndpoint(connection.endpoint);
  const openCode = connection.harness === "opencode" ? connection.endpoint : null;
  const stripped = model.startsWith(`${OPENCODE_CONNECTION_PROVIDER}/`)
    ? model.slice(OPENCODE_CONNECTION_PROVIDER.length + 1)
    : model;
  const upstreamModel = openCode?.models.includes(stripped) ? stripped : model;
  if (openCode && !openCode.models.includes(upstreamModel)) throw Error("model_connection_test_denied");
  const messages = connection.harness === "claude" || openCode?.protocol === "anthropic";
  const responses =
    !messages && (connection.harness === "codex" || openCode?.protocol === "openai" || openCode?.protocol === "azure");
  const path = messages ? (openCode ? "/messages" : "/v1/messages") : responses ? "/responses" : "/chat/completions";
  const url = new URL(endpoint.baseUrl + path);
  if (connection.harness === "codex" && "apiVersion" in endpoint && endpoint.apiVersion)
    url.searchParams.set("api-version", endpoint.apiVersion);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (openCode?.protocol === "azure") headers["api-key"] = connection.apiKey;
  else if (openCode?.protocol === "anthropic") headers["x-api-key"] = connection.apiKey;
  else if (connection.harness === "codex" || openCode || ("auth" in endpoint && endpoint.auth === "bearer"))
    headers.authorization = `Bearer ${connection.apiKey}`;
  else headers["x-api-key"] = connection.apiKey;
  if (messages) headers["anthropic-version"] = "2023-06-01";
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
            responses
              ? { model: upstreamModel, input: ".", max_output_tokens: 16, store: false }
              : { model: upstreamModel, max_tokens: 1, messages: [{ role: "user", content: "." }] },
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
          return {
            ok: false,
            status: response.status,
            error: "provider_rejected",
            code,
            ...(() => {
              const raw = response.headers.get("retry-after");
              if (response.status !== 429 || !raw || !/^\d{1,8}$/.test(raw)) return {};
              const seconds = Number(raw);
              return seconds <= 31_536_000 ? { retryAfterSeconds: seconds } : {};
            })(),
          };
        const valid =
          typeof body.id === "string" &&
          (responses
            ? body.object === "response" && ["completed", "incomplete"].includes(String(body.status))
            : messages
              ? body.type === "message" && body.role === "assistant" && Array.isArray(body.content)
              : body.object === "chat.completion" &&
                Array.isArray(body.choices) &&
                body.choices.some(
                  (choice) =>
                    choice &&
                    typeof choice === "object" &&
                    (choice as { message?: { role?: unknown } }).message?.role === "assistant",
                ));
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

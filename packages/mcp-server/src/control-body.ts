import { readBoundedText } from "@armada/auth";
import { VaultError } from "@armada/core/server";

const MAX_BODY_BYTES = 128 * 1024;

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  return readJsonBody(request, false);
}

/** Both policies count bytes before decoding; vault bodies additionally require valid UTF-8. */
export async function readVaultBody(request: Request): Promise<Record<string, unknown>> {
  return readJsonBody(request, true);
}

async function readJsonBody(request: Request, vault: boolean): Promise<Record<string, unknown>> {
  const invalid = (message: string) =>
    new VaultError("invalid", vault ? "Invalid application vault request." : message);
  const reader = vault ? request.body?.getReader() : undefined;
  const decoder = new TextDecoder("utf-8", { fatal: vault });
  let text = vault ? "" : await readBoundedText(request, MAX_BODY_BYTES),
    bytes = 0;
  try {
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > (vault ? 64 * 1024 : MAX_BODY_BYTES)) {
          // Do not drain an untrusted stream, or wait for its producer to finish cancellation.
          void reader.cancel().catch(() => {});
          throw invalid("The request is too large.");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    }
    if (!vault && text.trim() === "") return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid("The request is not JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw invalid("The request is not a JSON object.");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (vault) throw invalid("");
    throw error;
  } finally {
    reader?.releaseLock();
  }
}

/** Framing only: the caller authenticates first, then validates the parsed command envelope. */
export async function readRuntimeJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > 1048576) throw Error("request_too_large");
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let bytes = 0;
  try {
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1048576) {
          // Cancellation is advisory; a producer must not hold the refusal open.
          void reader.cancel().catch(() => {});
          throw Error("request_too_large");
        }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
    }
  } finally {
    reader?.releaseLock();
  }
  if (Buffer.byteLength(raw) > 1048576) throw Error("request_too_large");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw Error("invalid_request");
  }
}

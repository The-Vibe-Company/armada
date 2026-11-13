export class InvalidOrchestratorBody extends Error {}

/** Shared bounded UTF-8 stream parser. Never logs authorization, payloads or upstream errors. */
export async function readOrchestratorBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidOrchestratorBody();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let value = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 128 * 1024) {
        await reader.cancel();
        throw new InvalidOrchestratorBody();
      }
      value += decoder.decode(part.value, { stream: true });
    }
    return value + decoder.decode();
  } catch {
    throw new InvalidOrchestratorBody();
  } finally {
    reader.releaseLock();
  }
}

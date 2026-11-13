import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Read only accounting fields from the native rollout, before dispatching any new work.
 * Never retain transcript text. Missing/unreadable/malformed history stays unknown.
 */
export async function codexResumeUsage(path: string | null | undefined, sessionId: string) {
  if (!path) return null;
  let identity = false;
  let latest: Record<string, number> | null = null;
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.type === "session_meta") {
        if (identity || event.payload?.id !== sessionId) return null;
        identity = true;
      }
      if (event.type !== "event_msg" || event.payload?.type !== "token_count") continue;
      const total = event.payload.info?.total_token_usage;
      if (!total) continue; // Rate-limit-only notification.
      const mapped: Record<string, number> = {};
      for (const [native, key] of [
        ["input_tokens", "inputTokens"],
        ["output_tokens", "outputTokens"],
        ["cached_input_tokens", "cachedInputTokens"],
        ["cache_write_input_tokens", "cacheWriteInputTokens"],
        ["reasoning_output_tokens", "reasoningOutputTokens"],
      ]) {
        const value = total[native!];
        if (value === undefined && (native === "cache_write_input_tokens" || native === "reasoning_output_tokens"))
          continue;
        if (!Number.isSafeInteger(value) || value < 0) return null;
        mapped[key!] = value;
      }
      if (
        mapped.cachedInputTokens! + (mapped.cacheWriteInputTokens ?? 0) > mapped.inputTokens! ||
        (mapped.reasoningOutputTokens ?? 0) > mapped.outputTokens!
      ) return null;
      latest = mapped;
    }
    return identity ? latest : null;
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

import { modelThrottle } from "./model-rate-limit.ts";
import type { McpConfiguration } from "./protocol.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** The ACP prompt response contains only the final model step in this pin. Exported native messages own full-turn usage. */
export function exportedTurnUsage(saved: unknown, baseline: Set<string>) {
  const missing = {
    model: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  };
  if (!record(saved) || !Array.isArray(saved.messages)) return missing;
  const totals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const models = new Set<string>(),
    ids = new Set<string>();
  const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  for (const message of saved.messages) {
    if (!record(message) || !record(message.info)) return missing;
    const info = message.info;
    if (info.role !== "assistant") continue;
    if (typeof info.id !== "string") return missing;
    if (baseline.has(info.id)) continue;
    if (ids.has(info.id)) return missing;
    ids.add(info.id);
    const t = info.tokens;
    if (
      !record(t) ||
      !record(t.cache) ||
      !record(info.time) ||
      !count(info.time.completed) ||
      typeof info.finish !== "string" ||
      !count(t.total) ||
      !count(t.input) ||
      !count(t.output) ||
      !count(t.reasoning) ||
      !count(t.cache.read) ||
      !count(t.cache.write) ||
      typeof info.providerID !== "string" ||
      typeof info.modelID !== "string"
    )
      return missing;
    if (t.total !== t.input + t.output + t.reasoning + t.cache.read + t.cache.write) return missing;
    models.add(`${info.providerID}/${info.modelID}`);
    totals.inputTokens += t.input;
    // Native OpenCode output excludes reasoning; Armada's output includes that subset.
    totals.outputTokens += t.output + t.reasoning;
    totals.reasoningTokens += t.reasoning;
    totals.cachedTokens += t.cache.read;
    totals.cacheWriteTokens += t.cache.write;
    if (Object.values(totals).some((value) => !count(value))) return missing;
  }
  return ids.size ? { model: models.size === 1 ? [...models][0] : null, ...totals } : missing;
}

/** Native export, not ACP display titles, owns successful shell evidence. */
export function exportedToolProofs(saved: unknown, baseline: Set<string>, mcp?: McpConfiguration) {
  if (!record(saved) || !record(saved.info) || typeof saved.info.id !== "string" || !Array.isArray(saved.messages))
    return [];
  const proofs: { type: "armada/opencodeShell" | "armada/opencodeMcp"; data: Record<string, unknown> }[] = [],
    ids = new Set<string>(),
    calls = new Set<string>();
  for (const message of saved.messages) {
    if (!record(message) || !record(message.info) || typeof message.info.id !== "string" || !message.info.id) return [];
    const id = message.info.id;
    const info = message.info;
    if (ids.has(id)) return [];
    ids.add(id);
    if (baseline.has(id) || info.role !== "assistant") continue;
    if (info.sessionID !== saved.info.id) return [];
    if (
      !record(info.time) ||
      !Number.isSafeInteger(info.time.completed) ||
      (info.time.completed as number) < 0 ||
      !Array.isArray(message.parts)
    )
      return [];
    for (const part of message.parts) {
      if (!record(part) || part.type !== "tool" || typeof part.tool !== "string") continue;
      const nativeTool = part.tool;
      const shell = nativeTool === "bash" || nativeTool === "shell";
      const servers = Object.keys(mcp?.servers ?? {}).filter((name) =>
        nativeTool.startsWith(`${name.replace(/[^a-zA-Z0-9_-]/g, "_")}_`),
      );
      if (!shell && servers.length !== 1) continue;
      if (part.sessionID !== saved.info.id || part.messageID !== id) return [];
      if (typeof part.callID !== "string" || !part.callID || calls.has(part.callID)) return [];
      calls.add(part.callID);
      const state = part.state;
      if (
        !record(state) ||
        state.status !== "completed" ||
        !record(state.input) ||
        typeof state.output !== "string" ||
        Buffer.byteLength(JSON.stringify(state.input)) > 262144 ||
        Buffer.byteLength(state.output) > 65536 ||
        !record(state.metadata) ||
        state.metadata.truncated !== false
      )
        continue;
      const identity = { version: 1, nativeMessageId: id, callId: part.callID };
      if (!shell) {
        if (!mcp?.revision) continue;
        proofs.push({
          type: "armada/opencodeMcp",
          data: {
            ...identity,
            server: servers[0],
            configurationRevision: mcp.revision,
            nativeToolName: nativeTool,
            input: state.input,
            result: { output: state.output, isError: false },
          },
        });
        continue;
      }
      if (
        typeof state.input.command !== "string" ||
        state.metadata.exit !== 0 ||
        (state.metadata.timeout !== undefined && state.metadata.timeout !== false)
      )
        continue;
      proofs.push({
        type: "armada/opencodeShell",
        data: {
          version: 1,
          nativeMessageId: id,
          callId: part.callID,
          tool: part.tool,
          command: state.input.command,
          output: state.output,
          exitCode: 0,
          truncated: false,
        },
      });
    }
  }
  return proofs;
}

export { record as isOpenCodeRecord };

/** ACP drops HTTP metadata; the last new native assistant error is the authoritative terminal evidence. */
export function exportedModelThrottle(saved: unknown, baseline: Set<string>) {
  if (!record(saved) || !Array.isArray(saved.messages)) return;
  const assistant = saved.messages
    .filter(
      (message: unknown) =>
        record(message) &&
        record(message.info) &&
        message.info.role === "assistant" &&
        typeof message.info.id === "string" &&
        !baseline.has(message.info.id),
    )
    .at(-1);
  if (
    !record(assistant) ||
    !record(assistant.info) ||
    !record(assistant.info.error) ||
    assistant.info.error.name !== "APIError"
  )
    return;
  return modelThrottle(assistant.info.error);
}

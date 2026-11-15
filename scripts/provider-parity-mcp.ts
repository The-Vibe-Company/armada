import type { AgentEvent, ToolCall } from "../packages/core/src/provider.ts";
import type { EnvironmentDigestIo } from "./provider-parity-environment-digest.ts";

export interface McpProbeBinding {
  connectionId: string;
  tool: string;
  expectedText: string;
  readOnly: true;
}
export function isMcpProbeBinding(value: unknown): value is McpProbeBinding {
  if (!value || typeof value !== "object") return false;
  const v = value as McpProbeBinding;
  return (
    v.readOnly === true &&
    typeof v.connectionId === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v.connectionId) &&
    typeof v.tool === "string" &&
    /^parity_[A-Za-z0-9_-]{1,48}$/.test(v.tool) &&
    typeof v.expectedText === "string" &&
    /^parity_mcp_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v.expectedText)
  );
}
export class McpProbeError extends Error {
  constructor(
    readonly code: "invalid_mcp_binding" | "invalid_mcp_receipt" | "mcp_turn_failed" | "invalid_mcp_inventory",
  ) {
    super(code);
  }
}
function fail(code: McpProbeError["code"]): never {
  throw new McpProbeError(code);
}
function text(output: unknown): string | undefined {
  if (typeof output === "string") return output.trim();
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const result = output as { content?: unknown; isError?: unknown };
    if (result.isError === true) return;
    output = result.content;
  }
  if (Array.isArray(output) && output.every((block) => block?.type === "text" && typeof block.text === "string"))
    return output
      .map((block) => block.text)
      .join("\n")
      .trim();
}
/** Dedicated operator-attested read-only, zero-argument canary tool; expected output is never in the prompt. */
export async function prepareMcpProbe(
  template: { id: string; revision: number },
  binding: McpProbeBinding,
  io: EnvironmentDigestIo,
  harness: "codex" | "claude" | "opencode",
) {
  if (!isMcpProbeBinding(binding)) fail("invalid_mcp_binding");
  const connectionId = binding.connectionId.toLowerCase();
  const matches = (refs: unknown) =>
    Array.isArray(refs) && refs.length === 1 && typeof refs[0] === "string" && refs[0].toLowerCase() === connectionId;
  const source = await io.request<{ revision?: { revision?: number; definition?: { connections?: unknown } } }>(
    "templates/get",
    template,
  );
  if (source?.revision?.revision !== template.revision || !matches(source.revision.definition?.connections))
    fail("invalid_mcp_binding");
  const connected = (value: { connections?: Array<{ id?: string; status?: string }> }) =>
    Array.isArray(value?.connections) &&
    value.connections.filter(
      (item) => typeof item?.id === "string" && item.id.toLowerCase() === connectionId && item.status === "connected",
    ).length === 1;
  if (!connected(await io.request("mcp/list", {}))) fail("invalid_mcp_binding");
  const server = `armada_${connectionId.replaceAll("-", "_")}`;
  const nativeName = `${server}_${binding.tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  let inventory: string | undefined;
  async function checkInventory() {
    const result = await io.request<{
      mcpReady?: boolean;
      connections?: unknown;
      mcpToolInventory?: Array<{ connectionId?: string; tools?: unknown }>;
    }>("sandbox/mcp-preflight-v1", { runtimeVersion: 1, connections: [connectionId], toolInventory: true });
    const entry = result?.mcpToolInventory?.[0];
    if (
      result?.mcpReady !== true ||
      !matches(result.connections) ||
      !Array.isArray(result.mcpToolInventory) ||
      result.mcpToolInventory.length !== 1 ||
      typeof entry?.connectionId !== "string" ||
      entry.connectionId.toLowerCase() !== connectionId ||
      !Array.isArray(entry.tools) ||
      entry.tools.length > 10000 ||
      entry.tools.some((name) => typeof name !== "string" || !name || name.length > 512)
    )
      fail("invalid_mcp_inventory");
    const tools = entry.tools as string[];
    const matching = tools.filter((name) => `${server}_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}` === nativeName);
    if (new Set(tools).size !== tools.length || matching.length !== 1 || matching[0] !== binding.tool)
      fail("invalid_mcp_inventory");
    const current = JSON.stringify([...tools].sort());
    if (inventory !== undefined && current !== inventory) fail("invalid_mcp_inventory");
    inventory = current;
  }
  const boundedInventory = () =>
    io.poll(
      async () => {
        await checkInventory();
        return true;
      },
      (value) => value,
      1,
      io.until,
    );
  if (harness === "opencode") await boundedInventory();
  let verified = false;
  return {
    verifyManifest(manifest: {
      definition?: { connections?: unknown };
      connections?: Array<{ id?: string; version?: number; generation?: number }>;
    }) {
      const refs = manifest.connections;
      if (
        !matches(manifest.definition?.connections) ||
        !Array.isArray(refs) ||
        refs.length !== 1 ||
        refs[0]?.id?.toLowerCase() !== connectionId ||
        !Number.isSafeInteger(refs[0]?.version) ||
        (refs[0]?.version ?? 0) < 1 ||
        !Number.isSafeInteger(refs[0]?.generation) ||
        (refs[0]?.generation ?? 0) < 1
      )
        fail("invalid_mcp_binding");
    },
    async verify(id: string, provider: "boat" | "modal" | "docker") {
      if (harness === "opencode" && verified) await boundedInventory();
      if (!connected(await io.request("mcp/sandbox-connections", { id }))) fail("invalid_mcp_binding");
      const answer = `PARITY_MCP_DONE_${crypto.randomUUID()}`;
      const turn = await io.request<{ promptId?: string }>("sandbox/send", {
        id,
        prompt: `Call the dedicated read-only MCP tool ${binding.tool} on server ${server} exactly once with empty JSON arguments {}. Do not substitute shell or other tools. After it succeeds, reply exactly ${answer}. Do not print credentials or change files.`,
        ...(provider === "docker" ? { request_id: crypto.randomUUID() } : {}),
      });
      if (typeof turn?.promptId !== "string" || !turn.promptId) fail("invalid_mcp_receipt");
      let cursor: string | undefined,
        lastParent: string | undefined,
        finished = false;
      const messages = new Map<string, Extract<AgentEvent, { kind: "message" }>>();
      const nativeProofs = new Map<string, unknown>();
      await io.poll(
        () =>
          io.request<{ cursor?: string; hasMore?: boolean; events?: AgentEvent[] }>("logs/read", {
            id,
            coalesce: true,
            limit: 200,
            maxBytes: 262144,
            ...(cursor ? { cursor } : {}),
          }),
        (page) => {
          if (!Array.isArray(page?.events)) fail("invalid_mcp_receipt");
          cursor = page.cursor;
          for (const event of page.events) {
            if (event.promptId !== turn.promptId) continue;
            if (event.kind === "prompt") {
              if (["failed", "interrupted"].includes(event.status)) fail("mcp_turn_failed");
              finished ||= event.status === "finished";
            }
            if (harness === "opencode" && event.kind === "other" && event.type === "armada/opencodeMcp") {
              if (typeof event.id !== "string" || nativeProofs.size > 2000) fail("invalid_mcp_receipt");
              nativeProofs.set(event.id, event.data);
            }
            if (event.kind !== "message") continue;
            if (typeof event.id !== "string" || !Array.isArray(event.tools) || typeof event.text !== "string")
              fail("invalid_mcp_receipt");
            const key = event.messageId ?? event.id;
            const combined = event.textMode === "delta" ? (messages.get(key)?.text ?? "") + event.text : event.text;
            if (combined.length > 65536 || messages.size > 2000) fail("invalid_mcp_receipt");
            messages.set(key, { ...event, text: combined });
            if (!event.parentToolUseId && event.responseKind !== "tool_result") lastParent = key;
          }
          const calls = new Map<string, ToolCall>(),
            results = new Map<string, NonNullable<ToolCall["result"]>>();
          for (const event of messages.values()) {
            if (event.partial || event.retracted || event.parentToolUseId) continue;
            for (const tool of event.tools) {
              if (harness === "claude" && event.responseKind === "tool_result") {
                if (tool.name === "tool_result" && tool.result) results.set(tool.id, tool.result);
              } else calls.set(tool.id, tool);
            }
          }
          const object = (value: unknown): Record<string, unknown> =>
            value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
          const empty = (value: unknown) =>
            !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
          const found =
            harness === "opencode"
              ? [...nativeProofs.values()].some((raw) => {
                  const proof = object(raw),
                    result = object(proof.result);
                  return (
                    proof.version === 1 &&
                    typeof proof.nativeMessageId === "string" &&
                    !!proof.nativeMessageId &&
                    typeof proof.callId === "string" &&
                    !!proof.callId &&
                    typeof proof.configurationRevision === "string" &&
                    !!proof.configurationRevision &&
                    proof.server === server &&
                    proof.nativeToolName === nativeName &&
                    empty(proof.input) &&
                    result.isError === false &&
                    typeof result.output === "string" &&
                    text(result.output) === binding.expectedText
                  );
                })
              : [...calls.values()].some((tool) => {
                  const result = harness === "claude" ? results.get(tool.id) : tool.result;
                  return (
                    (harness === "claude"
                      ? tool.name === `mcp__${server}__${binding.tool}`
                      : tool.server === server && tool.name === binding.tool) &&
                    tool.input !== null &&
                    typeof tool.input === "object" &&
                    !Array.isArray(tool.input) &&
                    Object.keys(tool.input).length === 0 &&
                    result?.isError === false &&
                    text(result.output) === binding.expectedText
                  );
                });
          const final = lastParent ? messages.get(lastParent) : undefined;
          return (
            page.hasMore !== true &&
            finished &&
            found &&
            final?.partial === false &&
            !final.retracted &&
            final.text.trim() === answer
          );
        },
        110,
        io.until,
      );
      if (harness === "opencode") await boundedInventory();
      verified = true;
    },
  };
}

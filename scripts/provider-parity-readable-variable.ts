import { createHash } from "node:crypto";

export interface ReadableVariableBinding {
  id: string;
  version: number;
  key: string;
}
export interface ReadableProbeIo {
  request<T>(path: string, body: object): Promise<T>;
  poll<T>(read: () => Promise<T>, done: (value: T) => boolean, attempts: number, until: number): Promise<T>;
  until: number;
}
export class ReadableProbeError extends Error {
  constructor(
    readonly code:
      | "readable_canary_required"
      | "invalid_readable_binding"
      | "invalid_readable_receipt"
      | "readable_turn_failed"
      | "readable_delivery_mismatch",
  ) {
    super(code);
  }
}
function fail(code: ReadableProbeError["code"]): never {
  throw new ReadableProbeError(code);
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function isReadableVariableBinding(value: unknown): value is ReadableVariableBinding {
  const binding = object(value);
  return (
    typeof binding.id === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(binding.id) &&
    typeof binding.version === "number" &&
    Number.isSafeInteger(binding.version) &&
    binding.version > 0 &&
    typeof binding.key === "string" &&
    /^ARMADA_PARITY_[A-Z0-9_]{1,96}$/.test(binding.key)
  );
}

/** Read-only fixture: raw values stay out of probe logs and command/prompt text. Only a non-secret canary is accepted. */
export async function prepareReadableProbe(
  template: { id: string; revision: number },
  binding: ReadableVariableBinding,
  io: ReadableProbeIo,
) {
  if (!isReadableVariableBinding(binding)) fail("invalid_readable_binding");
  const variableId = binding.id.toLowerCase();
  const source = await io.request<{ revision?: { revision?: number; definition?: { variables?: unknown } } }>(
    "templates/get",
    template,
  );
  const bindings = source?.revision?.definition?.variables;
  const matches = (items: unknown) =>
    Array.isArray(items) &&
    items.filter((raw) => object(raw).key === binding.key).length === 1 &&
    items.some((raw) => {
      const item = object(raw);
      return (
        item.key === binding.key &&
        typeof item.variableId === "string" &&
        item.variableId.toLowerCase() === variableId &&
        item.version === binding.version
      );
    });
  if (source?.revision?.revision !== template.revision || !matches(bindings)) fail("invalid_readable_binding");
  const read = await io.request<{ item?: { id?: string; version?: number; status?: string }; value?: unknown }>(
    "variables/read",
    { id: variableId },
  );
  if (
    typeof read?.item?.id !== "string" ||
    read.item.id.toLowerCase() !== variableId ||
    read.item.version !== binding.version ||
    read.item.status !== "active"
  )
    fail("invalid_readable_binding");
  if (
    typeof read.value !== "string" ||
    !/^parity_readable_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(read.value)
  )
    fail("readable_canary_required");
  const nonce = crypto.randomUUID();
  const expected = createHash("sha256").update(`${read.value}:${nonce}`).digest("hex");
  // The validated key and public nonce are the only substitutions. The canary is never embedded.
  const command = `test "\${${binding.key}+x}" = x && printf '%s:%s' "$${binding.key}" '${nonce}' | sha256sum | cut -d ' ' -f 1`;
  const prompt = `Use your terminal tool to run exactly this command: ${command}\nReply with only its SHA-256 digest, no formatting or other text. Do not modify files or print environment values.`;
  return {
    verifyManifest(manifest: unknown) {
      if (!matches(object(manifest).variableProvenance)) fail("invalid_readable_binding");
    },
    async verify(id: string, provider: "boat" | "modal" | "docker") {
      const execution = await io.request<{ exitCode?: number; timedOut?: boolean; stdout?: string }>("sandbox/exec", {
        id,
        command,
        cwd: "/tmp",
        timeout_seconds: 30,
        ...(provider === "docker" ? { request_id: crypto.randomUUID() } : {}),
      });
      if (execution?.exitCode !== 0 || execution.timedOut !== false || execution.stdout?.trim() !== expected)
        fail("readable_delivery_mismatch");
      const turn = await io.request<{ promptId?: string }>("sandbox/send", {
        id,
        prompt,
        ...(provider === "docker" ? { request_id: crypto.randomUUID() } : {}),
      });
      if (typeof turn?.promptId !== "string" || !turn.promptId) fail("invalid_readable_receipt");
      let cursor: string | undefined;
      let finished = false;
      const messages = new Map<string, { text: string; eligible: boolean }>();
      await io.poll(
        () =>
          io.request<{
            cursor?: string;
            events?: Array<{
              id: string;
              messageId?: string;
              kind: string;
              promptId?: string;
              status?: string;
              text?: string;
              textMode?: string;
              partial?: boolean;
              responseKind?: string;
              parentToolUseId?: string;
              retracted?: boolean;
            }>;
          }>("logs/read", {
            id,
            coalesce: true,
            limit: 200,
            maxBytes: 262144,
            ...(cursor ? { cursor } : {}),
          }),
        (page) => {
          if (!Array.isArray(page?.events)) fail("invalid_readable_receipt");
          cursor = page.cursor;
          for (const event of page.events) {
            if (event.promptId !== turn.promptId) continue;
            if (event.kind === "prompt") {
              if (["failed", "interrupted"].includes(event.status ?? "")) fail("readable_turn_failed");
              finished ||= event.status === "finished";
            }
            if (event.kind !== "message" || typeof event.id !== "string") continue;
            const key = event.messageId ?? event.id;
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
          return (
            finished && [...messages.values()].some((message) => message.eligible && message.text.trim() === expected)
          );
        },
        110,
        io.until,
      );
    },
  };
}

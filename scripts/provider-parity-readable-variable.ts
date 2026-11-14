import { createHash } from "node:crypto";
import { type EnvironmentDigestIo, verifyEnvironmentDigest } from "./provider-parity-environment-digest.ts";

export interface ReadableVariableBinding {
  id: string;
  version: number;
  key: string;
}
export type { EnvironmentDigestIo as ReadableProbeIo } from "./provider-parity-environment-digest.ts";
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
    /^PARITY_READABLE_[A-Z0-9_]{1,96}$/.test(binding.key)
  );
}

/** Read-only fixture: raw values stay out of probe logs and command/prompt text. Only a non-secret canary is accepted. */
export async function prepareReadableProbe(
  template: { id: string; revision: number },
  binding: ReadableVariableBinding,
  io: EnvironmentDigestIo,
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
  return {
    verifyManifest(manifest: unknown) {
      if (!matches(object(manifest).variableProvenance)) fail("invalid_readable_binding");
    },
    async verify(id: string, provider: "boat" | "modal" | "docker") {
      await verifyEnvironmentDigest(id, provider, command, expected, io, (code) => {
        if (code === "invalid_receipt") fail("invalid_readable_receipt");
        if (code === "delivery_mismatch") fail("readable_delivery_mismatch");
        fail("readable_turn_failed");
      });
    },
  };
}

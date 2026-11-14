import { createHash } from "node:crypto";
import { parseApplicationSecretBindings } from "../packages/core/src/application-secret-bindings.ts";
import { shellQuote } from "../packages/core/src/shell-quote.ts";
import { type EnvironmentDigestIo, verifyEnvironmentDigest } from "./provider-parity-environment-digest.ts";

export interface SecretProbeBinding {
  id: string;
  version: number;
  key: string;
  canarySha256: string;
}
export class SecretProbeError extends Error {
  constructor(
    readonly code:
      | "invalid_secret_binding"
      | "secret_canary_expiry_unsupported"
      | "secret_delivery_mismatch"
      | "invalid_secret_receipt"
      | "secret_turn_failed",
  ) {
    super(code);
  }
}
function fail(code: SecretProbeError["code"]): never {
  throw new SecretProbeError(code);
}
export function isSecretProbeBinding(value: unknown): value is SecretProbeBinding {
  if (!value || typeof value !== "object") return false;
  const v = value as SecretProbeBinding;
  if (
    typeof v.key !== "string" ||
    !/^PARITY_SECRET_[A-Z0-9_]{1,96}$/.test(v.key) ||
    typeof v.canarySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.canarySha256)
  )
    return false;
  try {
    parseApplicationSecretBindings([{ key: v.key, secretId: v.id, version: v.version }]);
    return true;
  } catch {
    return false;
  }
}
/** Existing dedicated non-secret canary only. No API plaintext read, creation or mutation. */
export async function prepareSecretProbe(
  template: { id: string; revision: number },
  binding: SecretProbeBinding,
  io: EnvironmentDigestIo,
) {
  if (!isSecretProbeBinding(binding)) fail("invalid_secret_binding");
  const matches = (raw: unknown) =>
    Array.isArray(raw) &&
    raw.length === 1 &&
    raw[0]?.key === binding.key &&
    typeof raw[0]?.secretId === "string" &&
    raw[0].secretId.toLowerCase() === binding.id.toLowerCase() &&
    raw[0]?.version === binding.version;
  const source = await io.request<{ revision?: { revision?: number; definition?: { secrets?: unknown } } }>(
    "templates/get",
    template,
  );
  if (source?.revision?.revision !== template.revision || !matches(source.revision.definition?.secrets))
    fail("invalid_secret_binding");
  const listed = await io.request<{
    items?: Array<{ id?: string; version?: number; status?: string; expiresAt?: unknown }>;
  }>("secrets/list", {});
  if (!Array.isArray(listed?.items)) fail("invalid_secret_binding");
  const items = listed.items.filter(
    (item) => typeof item?.id === "string" && item.id.toLowerCase() === binding.id.toLowerCase(),
  );
  if (items.length !== 1 || items[0]?.version !== binding.version || items[0]?.status !== "active")
    fail("invalid_secret_binding");
  if (items[0].expiresAt !== null) fail("secret_canary_expiry_unsupported");
  const nonce = crypto.randomUUID();
  const expected = createHash("sha256").update(`${binding.canarySha256}:${nonce}`).digest("hex");
  // Neither the canary nor its expected hash appears in argv/prompt/logs. Guest rejects ordinary secrets.
  const program = `const c=require('node:crypto'),v=process.env[${JSON.stringify(binding.key)}];if(typeof v!=='string'||!/^parity_secret_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v))process.exit(1);const h=c.createHash('sha256').update(v).digest('hex');process.stdout.write(c.createHash('sha256').update(h+':'+${JSON.stringify(nonce)}).digest('hex'));`;
  const command = `node -e ${shellQuote(program)}`;
  return {
    verifyManifest(manifest: { definition?: { secrets?: unknown } }) {
      if (!matches(manifest.definition?.secrets)) fail("invalid_secret_binding");
    },
    async verify(id: string, provider: "boat" | "modal" | "docker") {
      await verifyEnvironmentDigest(id, provider, command, expected, io, (code) => {
        if (code === "invalid_receipt") fail("invalid_secret_receipt");
        if (code === "delivery_mismatch") fail("secret_delivery_mismatch");
        fail("secret_turn_failed");
      });
    },
  };
}

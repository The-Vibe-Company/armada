import { createHmac, timingSafeEqual } from "node:crypto";
import { refusal } from "./errors.ts";
import type { IngestGrantClaims, Machine, Scope } from "./ports.ts";
import { scopeKey } from "./store.ts";
export function createGenerationGrants(key: Uint8Array, scope: Scope) {
  if (key.length < 32)
    throw refusal("provider_not_configured", "Runner signing key must contain at least 32 random bytes.");
  const binding = scopeKey(scope);
  const mac = (body: string) => createHmac("sha256", key).update(body).digest();
  return {
    issue(machine: Machine) {
      if (!machine.grantExpiresAt || machine.grantExpiresAt <= Date.now())
        throw refusal("unauthorized", "Physical generation grant expired.");
      const claims = {
        sandboxId: machine.info.id,
        generation: String(machine.generation),
        expiresAt: machine.grantExpiresAt,
      };
      const body = Buffer.from(JSON.stringify({ ...claims, binding })).toString("base64url");
      return { token: `${body}.${mac(body).toString("base64url")}`, ...claims };
    },
    async verifyGrant(token: string): Promise<{ claims: IngestGrantClaims; scope: Scope }> {
      const parts = token.split(".");
      if (parts.length !== 2 || token.length > 4096) throw refusal("unauthorized", "Invalid runner grant.");
      const body = parts[0] ?? "";
      const signature = Buffer.from(parts[1] ?? "", "base64url");
      const expected = mac(body);
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected))
        throw refusal("unauthorized", "Invalid runner grant.");
      const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as IngestGrantClaims & { binding: string };
      if (
        claims.binding !== binding ||
        !Number.isFinite(claims.expiresAt) ||
        claims.expiresAt <= Date.now() ||
        typeof claims.sandboxId !== "string" ||
        typeof claims.generation !== "string"
      )
        throw refusal("unauthorized", "Runner grant is expired or out of scope.");
      return { claims, scope };
    },
  };
}

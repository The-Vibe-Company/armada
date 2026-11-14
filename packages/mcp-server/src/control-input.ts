import { VaultError } from "@armada/core/server";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function optional(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new VaultError("invalid", `${key} must be text.`);
  return value;
}

export function required(body: Record<string, unknown>, key: string): string {
  const value = optional(body, key);
  if (value === undefined) throw new VaultError("invalid", `${key} is required.`);
  return value;
}

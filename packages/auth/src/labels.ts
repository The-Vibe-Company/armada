import { AuthError } from "./errors.ts";

export function assertLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length < 1 || trimmed.length > 80 || hasControl(trimmed)) {
    throw new AuthError("A label is 1-80 characters.", "usage");
  }
  return trimmed;
}

/** MCP refresh tokens are bound to the client that received them. The label is not secret. */
export function refreshLabel(clientId: string): string {
  return `refresh:${clientId}`;
}

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function refreshClientId(label: string): string | null {
  const match = /^refresh:([0-9a-f]{32})$/.exec(label);
  return match?.[1] ?? null;
}

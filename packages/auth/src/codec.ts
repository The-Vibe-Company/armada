import { AuthError } from "./errors.ts";

export function randomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64urlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export function randomHex(size: number): string {
  return [...randomBytes(size)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Lowercase sha-256 hex, the only form the token tables accept. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function assertHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Token hash must be lowercase sha-256 hex.");
}

const TOKEN_PREFIX = {
  service: "armada_sk_",
  access: "armada_mcp_",
  refresh: "armada_mrt_",
} as const;

export type IssuedKind = keyof typeof TOKEN_PREFIX;

/** 32 bytes of entropy, prefixed so a bearer can be told from a refresh token before the lookup. */
export function generateToken(kind: IssuedKind): string {
  return `${TOKEN_PREFIX[kind]}${base64url(randomBytes(32))}`;
}

/** An authorization code. It is not a bearer: it has no `armada_` prefix. */
export function generateCode(): string {
  return base64url(randomBytes(32));
}

export function generateClientId(): string {
  return randomHex(16);
}

export const TOKEN_PATTERN = /^(armada_sk_|armada_mcp_|armada_mrt_)[A-Za-z0-9_-]{43}$/;

export function bearerKind(token: string): "service" | "access" | "refresh" | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  if (token.startsWith("armada_sk_")) return "service";
  if (token.startsWith("armada_mcp_")) return "access";
  return "refresh";
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, message = "Expected an id."): void {
  if (!UUID_PATTERN.test(value)) throw new AuthError(message, "usage");
}

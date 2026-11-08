import { base64url, base64urlDecode, randomBytes } from "./codec.ts";
import { AuthError } from "./errors.ts";
import { assertPublicUrl } from "./limits.ts";

const COOKIE = "armada_oauth";

export interface PendingLogin {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  csrf: string;
  exp: number;
  state?: string;
  supabaseVerifier?: string;
  userId?: string;
}

export async function seal(pending: PendingLogin, secret: string): Promise<string> {
  const key = await aesKey(secret);
  const iv = Uint8Array.from(randomBytes(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(pending))),
  );
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return base64url(packed);
}

export async function openSeal(value: string, secret: string, now: Date): Promise<PendingLogin | null> {
  const packed = base64urlDecode(value);
  if (!packed || packed.length < 13) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Uint8Array.from(packed.slice(0, 12)) },
      await aesKey(secret),
      Uint8Array.from(packed.slice(12)),
    );
    const pending = parsePending(JSON.parse(new TextDecoder().decode(plain)));
    if (!pending || pending.exp <= now.getTime()) return null;
    return pending;
  } catch {
    return null;
  }
}

export function readCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === COOKIE) return trimmed.slice(eq + 1);
  }
  return null;
}

export function writeCookie(value: string, publicUrl: string, maxAge: number): string {
  const secure = assertPublicUrl(publicUrl).startsWith("https://") ? "; Secure" : "";
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

export function clearCookie(publicUrl: string): string {
  return writeCookie("", publicUrl, 0);
}

async function aesKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 16) throw new AuthError("Set ARMADA_AUTH_SECRET.", "usage");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function parsePending(value: unknown): PendingLogin | null {
  if (!isRecord(value)) return null;
  const { clientId, redirectUri, codeChallenge, resource, csrf, exp } = value;
  if (
    typeof clientId !== "string" ||
    typeof redirectUri !== "string" ||
    typeof codeChallenge !== "string" ||
    typeof resource !== "string" ||
    typeof csrf !== "string" ||
    typeof exp !== "number"
  ) {
    return null;
  }
  const pending: PendingLogin = { clientId, redirectUri, codeChallenge, resource, csrf, exp };
  if (typeof value.state === "string") pending.state = value.state;
  if (typeof value.supabaseVerifier === "string") pending.supabaseVerifier = value.supabaseVerifier;
  if (typeof value.userId === "string") pending.userId = value.userId;
  return pending;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

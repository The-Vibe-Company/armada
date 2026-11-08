/** The one env var that holds the AES-256 key. The dashboard and credential resolution (#461) both use it. */
export const ENCRYPTION_KEY_ENV = "ARMADA_ENCRYPTION_KEY";

const KEY_BYTES = 32;
const IV_BYTES = 12;

export class EncryptionKeyError extends Error {
  override readonly name = "EncryptionKeyError";
}

/** The configured key, or `undefined` when it is missing. 32 bytes, base64. */
export function encryptionKey(): string | undefined {
  // Static access: Next.js inlines `process.env.NAME` and ignores a dynamic lookup.
  const value = process.env.ARMADA_ENCRYPTION_KEY?.trim();
  return value ? value : undefined;
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function importKey(key: string | undefined): Promise<CryptoKey> {
  if (!key?.trim()) {
    throw new EncryptionKeyError(`Credential encryption is not configured: set ${ENCRYPTION_KEY_ENV}.`);
  }
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(key.trim());
  } catch {
    throw new EncryptionKeyError(`${ENCRYPTION_KEY_ENV} is not valid base64.`);
  }
  if (raw.length !== KEY_BYTES) {
    throw new EncryptionKeyError(`${ENCRYPTION_KEY_ENV} must be ${KEY_BYTES} bytes (base64), got ${raw.length}.`);
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * AES-256-GCM. The result is `iv (12 bytes) || ciphertext || tag`: what goes into a `*_enc` column.
 * Omit `key` to use `ARMADA_ENCRYPTION_KEY`.
 */
export async function encryptSecret(
  plaintext: string,
  key: string | undefined = encryptionKey(),
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await importKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv, 0);
  out.set(sealed, IV_BYTES);
  return out;
}

/** Reverses `encryptSecret`. Omit `key` to use `ARMADA_ENCRYPTION_KEY`. */
export async function decryptSecret(
  sealed: Uint8Array<ArrayBuffer>,
  key: string | undefined = encryptionKey(),
): Promise<string> {
  const cryptoKey = await importKey(key);
  const iv = sealed.slice(0, IV_BYTES);
  const body = sealed.slice(IV_BYTES);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, body));
}

/** The text form PostgREST takes for a `bytea` value. */
export function toBytea(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `\\x${hex}`;
}

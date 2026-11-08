const KEY_BYTES = 32;
const IV_BYTES = 12;

export class MasterKeyError extends Error {
  override readonly name = "MasterKeyError";
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function importKey(masterKey: string | undefined): Promise<CryptoKey> {
  if (!masterKey?.trim()) {
    throw new MasterKeyError("Credential encryption is not configured: set ARMADA_MASTER_KEY on the dashboard.");
  }
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(masterKey.trim());
  } catch {
    throw new MasterKeyError("ARMADA_MASTER_KEY is not valid base64.");
  }
  if (raw.length !== KEY_BYTES) {
    throw new MasterKeyError(`ARMADA_MASTER_KEY must be ${KEY_BYTES} bytes (base64), got ${raw.length}.`);
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM. The result is `iv (12 bytes) || ciphertext || tag`: what goes into a `*_enc` column. */
export async function encryptSecret(
  plaintext: string,
  masterKey: string | undefined,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await importKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv, 0);
  out.set(sealed, IV_BYTES);
  return out;
}

export async function decryptSecret(sealed: Uint8Array<ArrayBuffer>, masterKey: string | undefined): Promise<string> {
  const key = await importKey(masterKey);
  const iv = sealed.slice(0, IV_BYTES);
  const body = sealed.slice(IV_BYTES);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body));
}

/** The text form PostgREST takes for a `bytea` value. */
export function toBytea(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `\\x${hex}`;
}

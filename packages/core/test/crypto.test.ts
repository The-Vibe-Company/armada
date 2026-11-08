import { describe, expect, test } from "bun:test";
import { decryptSecret, ENCRYPTION_KEY_ENV, EncryptionKeyError, encryptSecret, toBytea } from "../src/crypto.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("credential encryption", () => {
  test("a secret round-trips and the ciphertext does not contain it", async () => {
    const sealed = await encryptSecret("sk-ant-oat01-secret", KEY);
    expect(Buffer.from(sealed).includes("secret")).toBe(false);
    expect(sealed.length).toBe(12 + "sk-ant-oat01-secret".length + 16);
    expect(await decryptSecret(sealed, KEY)).toBe("sk-ant-oat01-secret");
  });

  test("each encryption uses a fresh IV", async () => {
    const [first, second] = await Promise.all([encryptSecret("same", KEY), encryptSecret("same", KEY)]);
    expect(toBytea(first)).not.toBe(toBytea(second));
  });

  test("a tampered ciphertext or another key is refused", async () => {
    const sealed = await encryptSecret("value", KEY);
    const tampered = sealed.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await expect(decryptSecret(tampered, KEY)).rejects.toThrow();
    await expect(decryptSecret(sealed, Buffer.alloc(32, 8).toString("base64"))).rejects.toThrow();
  });

  test("a missing or malformed key stops the save with a clear error", async () => {
    await expect(encryptSecret("value", undefined)).rejects.toThrow(EncryptionKeyError);
    await expect(encryptSecret("value", "  ")).rejects.toThrow(/not configured/);
    await expect(encryptSecret("value", "!!!not base64!!!")).rejects.toThrow(/base64/);
    await expect(encryptSecret("value", Buffer.alloc(16).toString("base64"))).rejects.toThrow(/32 bytes/);
  });

  test("the default key is ARMADA_ENCRYPTION_KEY", async () => {
    const previous = process.env[ENCRYPTION_KEY_ENV];
    process.env[ENCRYPTION_KEY_ENV] = KEY;
    try {
      expect(await decryptSecret(await encryptSecret("from-env"))).toBe("from-env");
    } finally {
      if (previous === undefined) delete process.env[ENCRYPTION_KEY_ENV];
      else process.env[ENCRYPTION_KEY_ENV] = previous;
    }
  });

  test("bytea is the hex form PostgREST takes", () => {
    expect(toBytea(new Uint8Array([0, 1, 171, 255]))).toBe("\\x0001abff");
  });
});

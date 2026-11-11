import { constants, createCipheriv, createHash, pbkdf2Sync, publicEncrypt, randomBytes } from "node:crypto";
import type { Provider } from "@armada/core";

/** Real encryption/chunk protocol with synthetic private bytes, not a fake receipt/store. */
export function encryptedRecoveryExec(archive: () => string, fallback: Provider["exec"]): Provider["exec"] {
  let transport = "";
  return async (request) => {
    if (request.preservationStage === "chunk_exec")
      return {
        detached: false,
        exitCode: 0,
        stdout: transport,
        stderr: "",
        timedOut: false,
        truncated: false,
      };
    const result = await fallback(request);
    if (result.detached || !result.stdout.includes('"status":"preserved"')) return result;
    const publicKey = request.command
      .match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/)?.[0]
      .replaceAll("\\n", "\n");
    if (!publicKey) throw new Error("Missing collector public key");
    const password = randomBytes(32).toString("hex"),
      salt = randomBytes(8);
    const derived = pbkdf2Sync(password, salt, 10000, 48, "sha256");
    const cipher = createCipheriv("aes-256-cbc", derived.subarray(0, 32), derived.subarray(32));
    const ciphertext = Buffer.concat([
      Buffer.from("Salted__"),
      salt,
      cipher.update(Buffer.from(archive(), "base64")),
      cipher.final(),
    ]);
    transport = ciphertext.toString("base64");
    const key = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(password),
    ).toString("base64");
    return {
      ...result,
      stdout: JSON.stringify({
        status: "preserved",
        bytes: ciphertext.length,
        sha256: createHash("sha256").update(ciphertext).digest("hex"),
        key,
      }),
    };
  };
}

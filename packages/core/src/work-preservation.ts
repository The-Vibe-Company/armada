import { constants, createDecipheriv, createHash, generateKeyPairSync, pbkdf2Sync, privateDecrypt } from "node:crypto";
import { type Provider, ProviderError } from "./provider.ts";
import { RECOVERY_BUN, RECOVERY_COLLECTOR } from "./work-preservation-collector.ts";

const FAILURE_REASONS = [
  "timeout",
  "unavailable",
  "exec_failed",
  "size_limit",
  "missing_git",
  "missing_bun",
  "missing_openssl",
  "collector_exit",
  "collector_signal",
  "collector_failed",
  "output_invalid",
  "output_truncated",
  "decrypt",
] as const;
type CaptureFailure = (typeof FAILURE_REASONS)[number];

// Never serialize providerCode, message, cause, details, or an arbitrary error name.
const ERROR_CLASSES = [
  "unauthorized",
  "payment_required",
  "forbidden",
  "not_found",
  "invalid_request",
  "provider_not_configured",
  "no_running_turn",
  "sandbox_not_ready",
  "conflict",
  "rate_limited",
  "unavailable",
  "unknown",
] as const;
export function workPreservationError(error: unknown): { errorClass: string; providerStatus: number | null } {
  if (error instanceof ProviderError)
    return {
      errorClass: ERROR_CLASSES.some((code) => code === error.code) ? `provider_${error.code}` : "provider_unknown",
      providerStatus:
        typeof error.status === "number" && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
          ? error.status
          : null,
    };
  return {
    errorClass:
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : error instanceof Error && error.name === "AbortError"
          ? "aborted"
          : "unexpected",
    providerStatus: null,
  };
}
type CaptureDiagnostic = ReturnType<typeof workPreservationError> & { stage: "collect_exec" | "chunk_exec" };

export type WorkPreservation =
  | { status: "clean" }
  | { status: "preserved"; archive: string }
  | { status: "failed"; reason: CaptureFailure; diagnostic?: CaptureDiagnostic };

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;

// Fixed command: neither credentials nor repository contents are interpolated into argv.
// The response is private recovery material, NOT an exec receipt suitable for logs or clients.
const CAPTURE = `${RECOVERY_BUN}
"$armada_bun" - <<'ARMADA_RECOVERY'
${RECOVERY_COLLECTOR}
ARMADA_RECOVERY`;

// 32 KiB raw -> 43,692 base64 bytes, below Modal's 65,536-byte stdout cap.
const CHUNK_BYTES = 32 * 1024;

function privateCommand(token: string, body: string): string {
  // Token is server-generated hex, never caller input or a credential.
  return `${RECOVERY_BUN}
"$armada_bun" - <<'ARMADA_RECOVERY'
const fs = require('node:fs');
const p='/tmp/armada-recovery-${token}';
${body}
ARMADA_RECOVERY`;
}

class CaptureError extends Error {
  constructor(
    readonly reason: CaptureFailure,
    readonly diagnostic?: CaptureDiagnostic,
  ) {
    super(reason);
  }
}

function checkedOutput(result: Awaited<ReturnType<Provider["exec"]>>): string {
  if (result.detached) throw new CaptureError("collector_exit");
  if (result.timedOut) throw new CaptureError("timeout");
  if (result.truncated) throw new CaptureError("output_truncated");
  if (result.exitCode !== 0)
    throw new CaptureError(
      result.exitCode !== null && (result.exitCode < 0 || result.exitCode >= 128)
        ? "collector_signal"
        : "collector_exit",
    );
  return result.stdout;
}

/** Local-only capture: valid and expired GitHub authorization take the same path.
 * The caller must encrypt the returned archive before persistence, and never log it.
 * Every response fits the runtime stdout cap. Timeout includes capture and all chunks.
 */
export async function preserveWork(provider: Pick<Provider, "exec">, sandboxId: string): Promise<WorkPreservation> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const token = crypto.randomUUID().replaceAll("-", "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let stage: CaptureFailure = "exec_failed";
  let execStage: CaptureDiagnostic["stage"] = "collect_exec";
  const timeout = (): WorkPreservation => ({
    status: "failed",
    reason: "timeout",
    diagnostic: { stage: execStage, errorClass: "timeout", providerStatus: null },
  });
  async function execute(request: Parameters<Provider["exec"]>[0], stage: CaptureDiagnostic["stage"] = "collect_exec") {
    execStage = stage;
    try {
      return await provider.exec(request);
    } catch (error) {
      throw new CaptureError("exec_failed", { stage, ...workPreservationError(error) });
    }
  }
  async function collect(): Promise<WorkPreservation> {
    const result = await execute({
      sandboxId,
      command: CAPTURE.replaceAll("ARMADA_TOKEN", token).replace(
        "ARMADA_PUBLIC_KEY",
        publicKey.replaceAll("\n", "\\n"),
      ),
      timeoutSeconds: 12,
      onlyIfRunning: true,
    });
    if (!result.detached && result.timedOut) return timeout();
    stage = "output_invalid";
    const value: unknown = JSON.parse(checkedOutput(result));
    if (typeof value !== "object" || value === null || !("status" in value)) throw new Error();
    if (value.status === "clean") return { status: "clean" };
    if (value.status === "preserved" && "bytes" in value && "sha256" in value && "key" in value) {
      const size = value.bytes;
      if (
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > MAX_ARCHIVE_BYTES + 32 ||
        typeof value.key !== "string" ||
        !/^[A-Za-z0-9+/]{342}==$/.test(value.key) ||
        typeof value.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.sha256)
      )
        throw new Error();
      const chunks: Buffer[] = [];
      const count = Math.ceil(size / CHUNK_BYTES);
      for (let start = 0; start < count; start += 8) {
        if (expired) return timeout();
        const batch = await Promise.all(
          Array.from({ length: Math.min(8, count - start) }, async (_, offset) => {
            const index = start + offset;
            const command = privateCommand(
              token,
              `const fd=fs.openSync(p+'/recovery.tar','r');
const data=Buffer.alloc(${CHUNK_BYTES});
try { const n=fs.readSync(fd,data,0,data.length,${index * CHUNK_BYTES}); console.log(data.subarray(0,n).toString('base64')); }
finally { fs.closeSync(fd); }`,
            );
            const output = checkedOutput(
              await execute({ sandboxId, command, timeoutSeconds: 2, onlyIfRunning: true }, "chunk_exec"),
            ).trim();
            if (output.length > 44_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) throw new Error();
            const decoded = Buffer.from(output, "base64");
            if (decoded.length !== Math.min(CHUNK_BYTES, size - index * CHUNK_BYTES)) throw new Error();
            return decoded;
          }),
        );
        chunks.push(...batch);
      }
      const archive = Buffer.concat(chunks);
      if (createHash("sha256").update(archive).digest("hex") !== value.sha256) throw new Error();
      stage = "decrypt";
      const password = privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(value.key, "base64"),
      );
      if (!/^[0-9a-f]{64}$/.test(password.toString()) || archive.subarray(0, 8).toString() !== "Salted__")
        throw new Error();
      const derived = pbkdf2Sync(password, archive.subarray(8, 16), 10000, 48, "sha256");
      const decipher = createDecipheriv("aes-256-cbc", derived.subarray(0, 32), derived.subarray(32));
      const plaintext = Buffer.concat([decipher.update(archive.subarray(16)), decipher.final()]);
      if (plaintext.length > MAX_ARCHIVE_BYTES) throw new Error();
      return { status: "preserved", archive: plaintext.toString("base64") };
    }
    if (value.status === "failed" && "reason" in value && FAILURE_REASONS.includes(value.reason as CaptureFailure))
      return { status: "failed", reason: value.reason as CaptureFailure };
    throw new Error();
  }
  try {
    return await Promise.race([
      collect(),
      new Promise<WorkPreservation>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve(timeout());
        }, 15_000);
      }),
    ]);
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof CaptureError ? error.reason : stage,
      ...(error instanceof CaptureError && error.diagnostic
        ? { diagnostic: error.diagnostic }
        : error instanceof CaptureError && error.reason === "timeout"
          ? { diagnostic: { stage: execStage, errorClass: "timeout", providerStatus: null } }
          : {}),
    };
  } finally {
    expired = true;
    clearTimeout(timer);
    // Only the sandbox-local janitor performs cleanup: a later provider exec could
    // otherwise auto-resume the machine after its caller has stopped it.
  }
}

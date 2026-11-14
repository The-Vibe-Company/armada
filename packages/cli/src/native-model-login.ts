import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultError } from "@armada/core";
import {
  NATIVE_CODEX_LOGIN_TIMEOUT_MS,
  NATIVE_CODEX_START_TIMEOUT_MS,
  NativeCodexLoginProtocol,
  validateNativeCodexAuth,
} from "./native-login-protocol.ts";

/** User-initiated foreground native login. Never forward native stdout/stderr or keep credentials after cleanup. */
export async function nativeCodexLogin(options: {
  path: string;
  signal: AbortSignal;
  device: (url: string, code: string) => void;
  executable?: string;
}): Promise<string> {
  if (process.platform === "win32") throw new VaultError("unavailable", "Secure native login requires Linux or macOS.");
  if (options.signal.aborted)
    throw new VaultError("invalid", "Native Codex login was cancelled before starting. No account was published.");
  const home = await mkdtemp(join(tmpdir(), "armada-native-login-")).catch(() => {
    throw new VaultError(
      "unavailable",
      "Could not create a private temporary Codex login directory. No account was published.",
    );
  });
  const deadline = new AbortController();
  let timer = setTimeout(
    () => deadline.abort(new DOMException("Login startup deadline", "TimeoutError")),
    NATIVE_CODEX_START_TIMEOUT_MS,
  );
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const child = spawn(options.executable ?? "codex", ["-c", 'cli_auth_credentials_store="file"', "app-server"], {
    detached: true,
    cwd: home,
    env: { PATH: options.path, HOME: home, CODEX_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  let abort = () => {};
  const protocol = new NativeCodexLoginProtocol(
    (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    (url, code) => {
      clearTimeout(timer);
      timer = setTimeout(
        () => deadline.abort(new DOMException("Approval deadline", "TimeoutError")),
        NATIVE_CODEX_LOGIN_TIMEOUT_MS,
      );
      options.device(url, code);
    },
  );
  let value: string | undefined;
  let failure: VaultError | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let buffer = "",
        bytes = 0;
      abort = () => reject(protocol.cancelled(signal));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      child.once("error", (error: NodeJS.ErrnoException) =>
        reject(
          protocol.failure(
            error.code === "ENOENT"
              ? "Could not start Codex: executable not found on PATH"
              : error.code === "EACCES"
                ? "Could not start Codex: executable permission denied"
                : "Could not start the native Codex process",
          ),
        ),
      );
      child.once("exit", (code, reason) => reject(protocol.exited(code, reason)));
      child.stderr.resume();
      child.stderr.on("error", () => reject(protocol.failure("The Codex diagnostic stream failed")));
      child.stdout.on("error", () => reject(protocol.failure("The Codex login protocol stream failed")));
      child.stdin.on("error", () => reject(protocol.failure("The connection to the Codex app-server closed")));
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65536) {
          reject(protocol.failure("Codex exceeded the bounded login protocol output"));
          return;
        }
        buffer += chunk.toString("utf8");
        let end = buffer.indexOf("\n");
        while (end >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            if (protocol.receive(JSON.parse(line))) resolve();
          } catch (error) {
            reject(error instanceof VaultError ? error : protocol.failure("Codex sent invalid login protocol JSON"));
            return;
          }
          end = buffer.indexOf("\n");
        }
      });
      protocol.start();
    });
    if (signal.aborted) throw protocol.cancelled(signal);
    let raw: string;
    try {
      raw = await readFile(join(home, "auth.json"), "utf8");
    } catch (error) {
      const missing = !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
      throw protocol.failure(
        missing
          ? "Codex approved the login but wrote no auth.json"
          : "Codex approved the login but its auth.json could not be read",
      );
    }
    if (signal.aborted) throw protocol.cancelled(signal);
    value = validateNativeCodexAuth(raw);
  } catch (error) {
    failure = error instanceof VaultError ? error : protocol.failure("Native Codex login failed unexpectedly");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(resolve, 2000);
        }),
      ]);
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }
    try {
      await rm(home, { recursive: true, force: true });
    } catch {
      failure = protocol.failure("Could not remove the private temporary Codex authentication directory");
    }
  }
  if (failure) throw failure;
  if (signal.aborted) throw protocol.cancelled(signal);
  if (value === undefined) throw protocol.failure("Codex produced no usable native authentication");
  return value;
}

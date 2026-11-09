import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultError } from "@armada/core";

/**
 * User-initiated local native device login, not a central OAuth client.
 * Codex owns OAuth and writes its private file. Only the device URL/code leave
 * this boundary; neither native stdout nor provider errors are forwarded.
 */
export async function nativeCodexLogin(options: {
  path: string;
  signal: AbortSignal;
  device: (url: string, code: string) => void;
  executable?: string;
}): Promise<string> {
  if (process.platform === "win32") throw new VaultError("unavailable", "Secure native login requires Linux or macOS.");
  if (options.signal.aborted) throw new VaultError("invalid", "Native login cancelled.");
  const home = await mkdtemp(join(tmpdir(), "armada-native-login-"));
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
  let abort: () => void = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      let buffer = "",
        bytes = 0,
        loginId: string | undefined;
      const fail = () => reject(new VaultError("unavailable", "Native Codex login failed or cancelled."));
      abort = fail;
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) {
        fail();
        return;
      }
      child.once("error", fail);
      child.once("exit", fail);
      child.stderr.resume();
      const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
      child.stdin.on("error", fail);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65536) {
          fail();
          return;
        }
        buffer += chunk.toString("utf8");
        let end = buffer.indexOf("\n");
        while (end >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.error) {
              fail();
              return;
            }
            if (message.id === 1) {
              send({ method: "initialized", params: {} });
              send({ id: 2, method: "account/login/start", params: { type: "chatgptDeviceCode" } });
            } else if (message.id === 2) {
              const result = message.result;
              const url = new URL(result.verificationUrl);
              if (
                result.type !== "chatgptDeviceCode" ||
                typeof result.loginId !== "string" ||
                url.origin !== "https://auth.openai.com" ||
                url.pathname !== "/codex/device" ||
                url.search ||
                url.hash ||
                url.username ||
                url.password ||
                typeof result.userCode !== "string" ||
                !/^[A-Z0-9-]{4,32}$/.test(result.userCode)
              ) {
                fail();
                return;
              }
              loginId = result.loginId;
              options.device(url.href, result.userCode);
            } else if (message.method === "account/login/completed") {
              if (!loginId || message.params?.loginId !== loginId || message.params?.success !== true) {
                fail();
                return;
              }
              resolve();
            }
          } catch {
            fail();
            return;
          }
          end = buffer.indexOf("\n");
        }
      });
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "armada-local-login", version: "1" },
          capabilities: {},
        },
      });
    });
    if (options.signal.aborted) throw new VaultError("invalid", "Native login cancelled.");
    const value = await readFile(join(home, "auth.json"), "utf8");
    if (Buffer.byteLength(value) > 65536) throw Error("oversized");
    const auth = JSON.parse(value);
    if (
      !auth.tokens ||
      typeof auth.tokens.access_token !== "string" ||
      typeof auth.tokens.refresh_token !== "string" ||
      typeof auth.tokens.account_id !== "string"
    )
      throw Error("invalid native auth");
    return value;
  } catch {
    throw new VaultError("unavailable", "Native Codex login failed or cancelled. No account was published.");
  } finally {
    options.signal.removeEventListener("abort", abort);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    await rm(home, { recursive: true, force: true });
  }
}

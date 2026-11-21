import { constants, existsSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { prepareAntigravity } from "../../agent-runtime/src/antigravity-install.ts";
import { ChildOwner } from "../../agent-runtime/src/children.ts";
import type { AntigravityLoginProcess } from "./antigravity-login.ts";

const appDataDir = "antigravity-acp";
const tokenBytes = 32 * 1024;
const stdoutBytes = 32 * 1024;
const caBundles = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem"];

async function readToken(profile: string): Promise<unknown> {
  const directory = await open(
    join(profile, appDataDir),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const file = await open(
      `/proc/self/fd/${directory.fd}/antigravity-oauth-token`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!(await file.stat()).isFile()) throw Error("Invalid Antigravity token file.");
      const buffer = Buffer.alloc(tokenBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > tokenBytes) throw Error("Invalid Antigravity token file.");
      const parsed: { token?: unknown } = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
      return parsed.token;
    } finally {
      await file.close();
    }
  } finally {
    await directory.close();
  }
}

export async function startAntigravityLoginProcess(
  cacheDir: string,
  signal: AbortSignal,
): Promise<AntigravityLoginProcess> {
  const executable = await prepareAntigravity({ cacheDir }, (url, init) => fetch(url, { ...init, signal }));
  signal.throwIfAborted();
  // A fixed parent prevents ambient TMPDIR and server configuration from entering the child.
  const profile = await mkdtemp("/tmp/armada-antigravity-login-");
  try {
    signal.throwIfAborted();
    const caBundle = caBundles.find((path) => existsSync(path));
    const owner = new ChildOwner();
    const child = owner.spawn(executable, ["acp", "--gemini-dir", profile, "--app-data-dir", appDataDir, "--login"], {
      cwd: profile,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: profile,
        GEMINI_HOME: profile,
        TMPDIR: profile,
        SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22",
        AGY_CLI_DISABLE_AUTO_UPDATE: "1",
        AGY_ACP_FORCE_FILE_STORAGE: "1",
        ...(caBundle ? { SSL_CERT_FILE: caBundle } : {}),
      },
    });
    child.stderr.resume();
    const exited = new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("exit", resolve);
    });
    const authorizationUrl = new Promise<string>((resolve, reject) => {
      let pending = "";
      let total = 0;
      function scan(chunk: Buffer) {
        total += chunk.length;
        if (total > stdoutBytes) {
          child.stdout.off("data", scan);
          reject(Error("Antigravity sign-in URL was unavailable."));
          return;
        }
        const lines = (pending + chunk.toString("utf8")).split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const url = line.trim();
          if (!url.startsWith("https://accounts.google.com/")) continue;
          child.stdout.off("data", scan);
          resolve(url);
          break;
        }
      }
      child.stdout.on("data", scan);
      child.stdout.once("end", () => reject(Error("Antigravity sign-in URL was unavailable.")));
      child.stdout.once("error", () => reject(Error("Antigravity sign-in URL was unavailable.")));
      void exited.then(() => reject(Error("Antigravity sign-in process exited.")));
    });
    return {
      authorizationUrl,
      exited,
      submitCode: (code) =>
        new Promise<void>((resolve, reject) => {
          child.stdin.write(`${code}\n`, (error) => (error ? reject(error) : resolve()));
        }),
      readToken: () => readToken(profile),
      async close() {
        try {
          await owner.release(child);
        } finally {
          await rm(profile, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

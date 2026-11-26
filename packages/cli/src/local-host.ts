import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse } from "node:path";
import { GoldenError, redact, shellQuote } from "@armada/core";
import { hostInstallClient } from "@armada/sdk/host-install";
import { parseArgs, single } from "./args.ts";
import type { Io } from "./run.ts";
import { stripControl } from "./table.ts";

interface FileInfo {
  directory: boolean;
  file: boolean;
  symlink: boolean;
}
export interface LocalHostIo {
  home: string;
  platform: string;
  arch: string;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  readStdin(): Promise<string>;
  stat(path: string): Promise<FileInfo | null>;
  mkdir(path: string): Promise<void>;
  writeExclusive(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  execute(
    program: string,
    args: string[],
    stdin?: string,
    timeoutMs?: number,
  ): Promise<{ code: number; stdout: string; stderr?: string }>;
  listInstances?(): Promise<string[]>;
  readServer?(path: string): Promise<string | undefined>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export function productionLocalHostIo(
  overrides: { fetch?: typeof fetch; readStdin?: () => Promise<string> } = {},
): LocalHostIo {
  return {
    listInstances: async () => {
      try {
        return (await readdir(join(homedir(), ".local/bin"))).filter((name) =>
          /^armada-docker-host@[a-f0-9]{64}$/.test(name),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    readServer: async (path) => {
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        return typeof value.server === "string" ? new URL(value.server).origin : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("Cannot read installation origin");
      }
    },
    home: homedir(),
    platform: process.platform,
    arch: process.arch,
    fetch: overrides.fetch ?? fetch,
    readStdin:
      overrides.readStdin ??
      (async () => {
        if (process.stdin.isTTY) invalid("Pipe the one-use registration token on stdin; never pass it as an argument.");
        return Bun.stdin.text();
      }),
    stat: async (path) => {
      try {
        const info = await lstat(path);
        return { directory: info.isDirectory(), file: info.isFile(), symlink: info.isSymbolicLink() };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    mkdir: async (path) => {
      await mkdir(path, { mode: 0o700 });
    },
    writeExclusive: async (path, bytes) => {
      await writeFile(path, bytes, { mode: 0o700, flag: "wx" });
    },
    rename,
    remove: async (path) => {
      await unlink(path);
    },
    execute: async (program, args, stdin, timeoutMs = 30_000) => {
      const child = Bun.spawn([program, ...args], {
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code: await child.exited, stdout, stderr };
    },
    now: Date.now,
    sleep: Bun.sleep,
  };
}

const invalid = (message: string): never => {
  throw new GoldenError("invalid_config", message);
};
const failed = (message: string): never => {
  throw new GoldenError("build_failed", message);
};
const HELP = `Usage: armada host install --server HTTPS_ORIGIN
Install/register the local Docker host daemon, or safely upgrade an existing registration.
Run on the Docker machine (Linux x64 or arm64); no Armada login or organization selector.
Obtain a one-use registration command with armada host add from your signed-in client.
The token is supplied on stdin, never as an argument. Protect token files and installer output.
--server must be an HTTPS origin without credentials, path, query or fragment.
Downloaded artifacts are digest-verified before execution. An already registered machine
keeps its registration/name for the same server; another server gets a separate service.
Do not blindly repeat registration after an uncertain failure.
Inspect the daemon instance for this server and Docker/systemd access before retrying.
Example: armada host install --server https://armada.example < /private/registration-token
`;

interface Status {
  registered: boolean;
  connected: boolean;
  hostId?: string;
  version: string;
  server?: string;
}
const instanceArgs = (binary: string): string[] => {
  const match = /armada-docker-host@([a-f0-9]{64})(?:\.|$)/.exec(binary);
  return match ? ["--instance", match[1] as string] : [];
};
function statusCommand(binary: string): string {
  return [shellQuote(binary), "status", ...instanceArgs(binary)].join(" ");
}

async function status(native: LocalHostIo, binary: string, timeoutMs = 30_000): Promise<Status> {
  const result = await native.execute(binary, ["status", ...instanceArgs(binary)], undefined, timeoutMs);
  if (result.code !== 0)
    return failed(
      `Cannot read Docker host status. Registration and the new token are preserved. Run ${statusCommand(binary)} to diagnose it.`,
    );
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return failed("Invalid Docker host status; registration and the new token are preserved.");
  }
  if (!value || typeof value !== "object") return failed("Invalid Docker host status.");
  const s = value as Record<string, unknown>;
  if (
    typeof s.registered !== "boolean" ||
    typeof s.connected !== "boolean" ||
    (!s.registered && s.connected) ||
    typeof s.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(s.version) ||
    (s.registered && (typeof s.hostId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(s.hostId)))
  )
    return failed("Invalid Docker host status; registration and the new token are preserved.");
  return {
    registered: s.registered,
    connected: s.connected,
    version: s.version,
    ...(typeof s.server === "string" && /^https:\/\/[^\s/]+$/.test(s.server) ? { server: s.server } : {}),
    ...(s.registered ? { hostId: s.hostId as string } : {}),
  };
}

async function checkPath(native: LocalHostIo, path: string, create = false): Promise<FileInfo | null> {
  const parent = dirname(path);
  if (parent !== path) {
    const info = await checkPath(native, parent, create);
    if (!info) return null;
    if (!info.directory) return failed("Docker host installation parent is not a directory.");
  }
  let info = await native.stat(path);
  if (info?.symlink) return failed("Refusing a symbolic link in the Docker host installation path.");
  if (!info && create) {
    await native.mkdir(path);
    info = await native.stat(path);
    if (!info?.directory || info.symlink) return failed("Unsafe Docker host installation directory.");
  }
  return info;
}

async function connected(native: LocalHostIo, binary: string, io: Io): Promise<number> {
  const deadline = native.now() + 60_000;
  let waited = 0;
  while (waited < 60_000 && native.now() < deadline) {
    const current = await status(native, binary, Math.min(30_000, deadline - native.now()));
    if (current.registered && current.connected) {
      io.out(`${JSON.stringify(current)}\nDocker host connected.\n`);
      return 0;
    }
    const delay = Math.min(1000, 60_000 - waited, deadline - native.now());
    if (delay <= 0) break;
    await native.sleep(delay);
    waited += delay;
  }
  io.err(
    `Docker host is still offline. Registration preserved. Check ${statusCommand(binary)} and journalctl --user -u ${basename(binary)}.service. Do not repeat registration.\n`,
  );
  return 1;
}

async function downloadHost(native: LocalHostIo, server: string): Promise<Uint8Array> {
  const client = hostInstallClient(server, (input, init) => native.fetch(input, init));
  const download = async (request: ReturnType<typeof client.manifest>) => {
    const { response, valid } = await request;
    if (!valid) return failed("Host download failed or redirected; no downloaded binary was executed.");
    return response;
  };
  const manifest: unknown = await (await download(client.manifest())).json();
  if (!manifest || typeof manifest !== "object") return failed("Invalid host install manifest.");
  const pins = manifest as Record<string, unknown>;
  const digest = pins[native.arch];
  if (typeof pins.version !== "string" || !pins.version || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
    return failed("Invalid host install manifest.");
  const bytes = new Uint8Array(await (await download(client.artifact(digest))).arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    return failed("Docker host artifact digest mismatch; no downloaded binary was installed or executed.");
  return bytes;
}

export async function localHostCommand(argv: readonly string[], io: Io, native: LocalHostIo) {
  let otherOrigin: string | undefined;
  try {
    if (argv.length === 1 && ["--help", "-h"].includes(argv[0] ?? "")) {
      io.out(HELP);
      return 0;
    }
    const args = parseArgs(argv, ["--server"]);
    if (args.positionals.length || [...args.options.keys()].some((key) => key !== "--server"))
      return invalid(HELP.trim());
    const raw = single(args, "--server");
    let url: URL;
    try {
      url = new URL(raw ?? "");
    } catch {
      return invalid("--server requires an HTTPS origin.");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      raw?.trim() !== raw ||
      (raw !== url.origin && raw !== `${url.origin}/`) ||
      /[\s\\]/.test(raw ?? "")
    )
      return invalid("--server requires an HTTPS origin without credentials, path, query or fragment.");
    const server = url.origin;
    if (native.platform !== "linux" || !["x64", "arm64"].includes(native.arch))
      return invalid("Docker host installation requires Linux x64 or arm64.");
    if (!native.home.startsWith(parse(native.home).root) || !parse(native.home).root)
      return failed("An absolute home directory is required.");
    const legacy = "armada-docker-host";
    const names = [legacy, ...((await native.listInstances?.()) ?? [])];
    const installations: { name: string; server: string | undefined; current: Status }[] = [];
    for (const name of names) {
      const path = join(native.home, ".local/bin", name);
      const present = await checkPath(native, path);
      if (!present) continue;
      if (!present.file) return failed("Docker host binary path is not a regular file.");
      const statePath = join(native.home, ".local/state", name, "state.json");
      await checkPath(native, statePath);
      const savedOrigin = await native.readServer?.(statePath);
      const current =
        savedOrigin && savedOrigin !== server
          ? { registered: true, connected: false, version: "0.0.0" }
          : await status(native, path);
      const origin = savedOrigin ?? current.server;
      installations.push({ name, server: origin, current });
    }
    otherOrigin = installations.find((i) => i.server && i.server !== server)?.server;
    const matched = installations.find((i) => i.server === server);
    const legacyInstall = installations.find((i) => i.name === legacy);
    if (legacyInstall?.current.registered && !legacyInstall.server)
      return failed(
        `The existing Docker host origin cannot be read. The new token was not consumed. Run ${statusCommand(join(native.home, ".local/bin", legacy))} before retrying.`,
      );
    const name =
      matched?.name ??
      (installations.length ? `armada-docker-host@${createHash("sha256").update(server).digest("hex")}` : legacy);
    const binary = join(native.home, ".local/bin", name);
    const info = await checkPath(native, binary);
    if (info && !info.file) return failed("Docker host binary path is not a regular file.");
    const current = matched?.current ?? (info ? await status(native, binary) : null);
    if (current?.registered) {
      const bytes = await downloadHost(native, server);
      const temporary = `${binary}.${randomUUID()}.tmp`;
      await native.writeExclusive(temporary, bytes);
      try {
        if (
          (
            await native.execute(
              temporary,
              ["upgrade", "--server", server, ...instanceArgs(binary)],
              undefined,
              180_000,
            )
          ).code !== 0
        )
          return failed(
            `Could not upgrade this Docker host; registration and token preserved. Run ${statusCommand(binary)} before retrying.`,
          );
      } finally {
        await native.remove(temporary);
      }
      const token = (await native.readStdin()).trim();
      if (!/^[a-f0-9]{64}$/.test(token))
        return invalid("Pipe a valid one-use registration token on stdin; never pass it as an argument.");
      let displayName: string | null = null;
      try {
        const { response, valid } = await hostInstallClient(server, (input, init) =>
          native.fetch(input, init),
        ).reuseRegistration(token, current.hostId!);
        if (!valid) throw new Error("Cannot reconcile registration");
        const value: unknown = await response.json();
        if (!value || typeof value !== "object") throw new Error("Invalid identity");
        const identity = value as Record<string, unknown>;
        if (
          identity.hostId !== current.hostId ||
          !(
            identity.name === null ||
            (typeof identity.name === "string" &&
              identity.name.length > 0 &&
              identity.name.length <= 64 &&
              !/[\p{C}]/u.test(identity.name))
          )
        )
          throw new Error("Invalid identity");
        displayName = identity.name as string | null;
        io.out("The unused new registration was canceled; its token was not exchanged for machine credentials.\n");
      } catch {
        io.err(
          "Could not reconcile the unused registration or look up its name. It will expire automatically; Ctrl-C stops host add waiting. Existing credentials are preserved.\n",
        );
      }
      io.out(
        `This machine is already registered as ${displayName === null ? current.hostId : `${JSON.stringify(displayName)} (${current.hostId})`}.\nExisting Docker host: ${JSON.stringify(current)}\nKeeping its registration; the host binary was checked and upgraded safely.\n`,
      );
      if (!current.connected) {
        io.out("Restarting the existing user service and waiting up to 60 seconds for connection.\n");
        if ((await native.execute("systemctl", ["--user", "restart", `${name}.service`])).code !== 0)
          return failed("Could not restart the existing Docker host user service; registration and token preserved.");
      }
      return connected(native, binary, io);
    }
    for (const path of [
      join(native.home, ".local/state", name, "state.json"),
      join(native.home, ".local/state", name, "managed.json"),
      join(native.home, ".config/systemd/user", `${name}.service`),
    ]) {
      if (await checkPath(native, path))
        return failed(
          "Existing Docker host installation files found without readable registration; state and new token preserved. Repair the existing installation before replacing its binary.",
        );
    }
    const token = (await native.readStdin()).trim();
    if (!/^[a-f0-9]{64}$/.test(token))
      return invalid("Pipe a valid one-use registration token on stdin; never pass it as an argument.");
    const bytes = await downloadHost(native, server);
    await checkPath(native, dirname(binary), true);
    const temporary = `${binary}.${randomUUID()}.tmp`;
    await native.writeExclusive(temporary, bytes);
    try {
      await native.rename(temporary, binary);
    } finally {
      try {
        await native.remove(temporary);
      } catch {}
    }
    io.out(current ? "Replacing the unregistered Docker host binary.\n" : "Installing Docker host user service.\n");
    const install = await native.execute(
      binary,
      ["install", "--server", server, ...instanceArgs(binary)],
      `${token}\n`,
      660_000,
    );
    if (install.code !== 0) {
      const detail = safePreflightLines(install.stderr, token);
      return failed(
        `${detail ? `${detail} ` : ""}Docker host installation did not complete. Run ${statusCommand(binary)} and inspect systemd/Docker access before retrying.`,
      );
    }
    io.out("Waiting up to 60 seconds for the Docker host to connect…\n");
    return connected(native, binary, io);
  } catch (error) {
    if (error instanceof GoldenError) {
      if (otherOrigin)
        throw new GoldenError(
          error.code,
          `This machine is already connected to ${otherOrigin}. The additional installation could not complete. ${error.message} Inspect the installed daemon status.`,
        );
      throw error;
    }
    return failed(
      "Docker host command failed; private state and credentials were not printed. Check Docker/systemd access and the installed daemon before retrying registration.",
    );
  }
}

const SENSITIVE_PATTERN =
  /(?:authorization\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?\S+|(?:bearer|basic)\s+\S+|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|armada_[a-z]+_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|https?:\/\/[^/\s]+:[^/\s]+@\S+|[a-f0-9]{32,}|(?:token|secret|password|api[_-]?key|credential)\s*[:=]\s*\S+)/gi;

function safePreflightLines(stderr: string | undefined, token: string) {
  if (!stderr) return "";
  const lowerToken = token.toLowerCase();
  const tokenRe = token ? new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : undefined;
  const safe: string[] = [];
  for (const rawLine of stderr.split(/\r?\n/)) {
    if (safe.length >= 3) break;
    let clean = stripControl(rawLine).replace(/\s+/g, " ").trim();
    if (!clean || /^(?:at\s+|[{[])/.test(clean)) continue;
    clean = redact(clean, [token]);
    if (tokenRe) clean = clean.replace(tokenRe, "[REDACTED]");
    clean = clean.replace(SENSITIVE_PATTERN, "[REDACTED]");
    if (!clean || clean === "[REDACTED]" || clean === "***" || (lowerToken && clean.toLowerCase().includes(lowerToken)))
      continue;
    safe.push(clean.length > 200 ? `${clean.slice(0, 199)}…` : clean);
  }
  return safe.join(" ");
}

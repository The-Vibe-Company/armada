import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { GoldenError } from "@armada/core";
import { parseArgs, single } from "./args.ts";
import type { Io } from "./run.ts";

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
  ): Promise<{ code: number; stdout: string }>;
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
        // Native failures may include private response bytes. Never relay them.
        stderr: "ignore",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      const stdout = await new Response(child.stdout).text();
      return { code: await child.exited, stdout };
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
const HELP =
  "Usage: armada host install --server HTTPS_ORIGIN | status | uninstall\nRegistration token is read from stdin; no Armada login is required.\n";
const LEAF_HELP: Record<string, string> = {
  install: `Usage: armada host install --server HTTPS_ORIGIN
Install/register the local Docker host daemon, or safely upgrade an existing registration.
Run on the Docker machine (Linux x64 or arm64); no Armada login or organization selector.
Obtain a one-use registration command with armada host add from your signed-in client.
The token is supplied on stdin, never as an argument. Protect token files and installer output.
--server must be an HTTPS origin without credentials, path, query or fragment.
Downloaded artifacts are digest-verified before execution. An already registered machine
keeps its registration; do not blindly repeat registration after an uncertain failure.
Inspect armada host status and Docker/systemd access before retrying.
Example: armada host install --server https://armada.example < /private/registration-token
`,
  status: `Usage: armada host status [--server HTTPS_ORIGIN]
Inspect the local Docker host daemon, not an organization host list or sandbox status.
Run on the Docker machine (Linux x64 or arm64); no Armada login or organization selector.
Always emits sanitized JSON on stdout; no --json flag is needed or accepted.
Includes registered/connected, with version and host ID when available. A missing binary
reports {"registered":false,"connected":false}; it is not an installation attempt.
Private machine credentials and raw native status output are not printed.
For server-side host metadata use armada host list/show from a signed-in client.
Example: armada host status
`,
  uninstall: `Usage: armada host uninstall [--server HTTPS_ORIGIN]
Remove the local Armada Docker host installation, not an organization registration command.
Run on the Docker machine (Linux x64 or arm64); no Armada login or organization selector.
Delegates to the installed host binary's uninstall/drain lifecycle. Shared images and other
workloads are preserved. A missing installation is a successful no-op.
If uninstall does not complete, state is preserved; run armada-docker-host uninstall to
diagnose or reconcile the drain rather than manually deleting installation state.
This command prints human output; --json is not accepted.
Example: armada host uninstall
`,
};

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
async function status(native: LocalHostIo, binary: string, timeoutMs = 30_000): Promise<Status> {
  const result = await native.execute(binary, ["status", ...instanceArgs(binary)], undefined, timeoutMs);
  if (result.code !== 0)
    return failed(
      "Cannot read Docker host status; registration and the new token are preserved. Run armada-docker-host status to diagnose it.",
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

/** Check every ancestor, not just the executable: never follow an installation symlink. */
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
    "Docker host is still offline; registration preserved. Check armada host status and journalctl --user -u armada-docker-host.service; do not repeat registration.\n",
  );
  return 1;
}

async function downloadHost(native: LocalHostIo, server: string): Promise<Uint8Array> {
  const download = async (path: string) => {
    const response = await native.fetch(`${server}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || response.redirected || (response.url && response.url !== `${server}${path}`))
      return failed("Host download failed or redirected; no downloaded binary was executed.");
    return response;
  };
  const manifest: unknown = await (await download("/api/docker-host/install.json")).json();
  if (!manifest || typeof manifest !== "object") return failed("Invalid host install manifest.");
  const pins = manifest as Record<string, unknown>;
  const digest = pins[native.arch];
  if (typeof pins.version !== "string" || !pins.version || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
    return failed("Invalid host install manifest.");
  const bytes = new Uint8Array(await (await download(`/api/runtime/artifacts/${digest}`)).arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    return failed("Docker host artifact digest mismatch; no downloaded binary was installed or executed.");
  return bytes;
}

export async function localHostCommand(argv: readonly string[], io: Io, native: LocalHostIo): Promise<number> {
  try {
    const [operation, ...rest] = argv;
    if (rest.length === 1 && ["--help", "-h"].includes(rest[0] ?? "")) {
      io.out(LEAF_HELP[operation ?? ""] ?? HELP);
      return 0;
    }
    const args = parseArgs(rest, ["--server"]);
    if (
      !["install", "status", "uninstall"].includes(operation ?? "") ||
      args.positionals.length ||
      [...args.options.keys()].some((key) => key !== "--server")
    )
      return invalid(HELP.trim());
    let server: string | undefined;
    if (operation === "install" || single(args, "--server") !== undefined) {
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
      server = url.origin;
    }
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
      const current = await status(native, path);
      const statePath = join(native.home, ".local/state", name, "state.json");
      await checkPath(native, statePath);
      const origin = current.server ?? (await native.readServer?.(statePath));
      installations.push({ name, server: origin, current });
    }
    if (!server && installations.length > 1) {
      io.out(
        `${JSON.stringify({ instances: installations.map((i) => ({ ...i.current, server: i.server, binary: join(native.home, ".local/bin", i.name) })) })}\nSelect an instance with armada host ${operation} --server HTTPS_ORIGIN.\n`,
      );
      return 0;
    }
    const matched = server ? installations.find((i) => i.server === server) : installations[0];
    const legacyInstall = installations.find((i) => i.name === legacy);
    // An older daemon may not expose its origin. Never guess or exchange a token.
    if (server && legacyInstall?.current.registered && !legacyInstall.server)
      return failed(
        "The existing Docker host origin cannot be read; the new token was not consumed. Run armada host status to inspect the existing instance before retrying.",
      );
    const name =
      matched?.name ??
      (server && installations.length
        ? `armada-docker-host@${createHash("sha256").update(server).digest("hex")}`
        : legacy);
    const binary = join(native.home, ".local/bin", name);
    const info = await checkPath(native, binary);
    if (info && !info.file) return failed("Docker host binary path is not a regular file.");
    const current = matched?.current ?? (info ? await status(native, binary) : null);
    if (operation === "status") {
      io.out(`${JSON.stringify(current ?? { registered: false, connected: false })}\n`);
      return 0;
    }
    if (operation === "uninstall") {
      if (!info) {
        io.out("Docker host is not installed.\n");
        return 0;
      }
      if ((await native.execute(binary, ["uninstall", ...instanceArgs(binary)], undefined, 660_000)).code !== 0)
        return failed(
          "Docker host uninstall did not complete; state preserved. Run armada-docker-host uninstall to diagnose or reconcile the drain.",
        );
      io.out("Uninstalled Armada Docker host. Shared images and other workloads preserved.\n");
      return 0;
    }
    if (current?.registered) {
      const bytes = await downloadHost(native, server ?? "");
      const temporary = `${binary}.${randomUUID()}.tmp`;
      await native.writeExclusive(temporary, bytes);
      try {
        if (
          (
            await native.execute(
              temporary,
              ["upgrade", "--server", server ?? "", ...instanceArgs(binary)],
              undefined,
              180_000,
            )
          ).code !== 0
        )
          return failed(
            `Could not upgrade this Docker host; registration and token preserved. Run armada host status --server ${server} before retrying.`,
          );
      } finally {
        await native.remove(temporary);
      }
      const token = (await native.readStdin()).trim();
      if (!/^[a-f0-9]{64}$/.test(token))
        return invalid("Pipe a valid one-use registration token on stdin; never pass it as an argument.");
      let displayName: string | null = null;
      try {
        const response = await native.fetch(`${server}/api/docker-host/reuse-registration`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ hostId: current.hostId }),
        });
        if (
          !response.ok ||
          response.redirected ||
          (response.url && response.url !== `${server}/api/docker-host/reuse-registration`)
        )
          throw new Error("Cannot reconcile registration");
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
    // Never replace an installation whose registration/ownership cannot be read.
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
    const bytes = await downloadHost(native, server ?? "");
    await checkPath(native, dirname(binary), true);
    const temporary = `${binary}.${randomUUID()}.tmp`;
    await native.writeExclusive(temporary, bytes);
    try {
      await native.rename(temporary, binary);
    } finally {
      try {
        await native.remove(temporary);
      } catch {
        /* Renamed or already removed. */
      }
    }
    io.out(current ? "Replacing the unregistered Docker host binary.\n" : "Installing Docker host user service.\n");
    if (
      (
        await native.execute(
          binary,
          ["install", "--server", server ?? "", ...instanceArgs(binary)],
          `${token}\n`,
          660_000,
        )
      ).code !== 0
    )
      return failed(
        "Docker host installation did not complete. Run armada host status and inspect systemd/Docker access; do not blindly repeat registration.",
      );
    io.out("Waiting up to 60 seconds for the Docker host to connect…\n");
    return connected(native, binary, io);
  } catch (error) {
    if (error instanceof GoldenError) throw error;
    // Do not expose native stdout/stderr, stdin or transport response diagnostics.
    return failed(
      "Docker host command failed; private state and credentials were not printed. Check Docker/systemd access and armada host status before retrying registration.",
    );
  }
}

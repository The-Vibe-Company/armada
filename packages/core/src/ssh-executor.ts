import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoldenBuildWarning } from "./golden-build-warning.ts";
import { GOLDEN_SSH_RECEIPT_PHASES, GoldenError, snapshotMissingRefMessage } from "./golden-config.ts";
import { outputCollectorFailureDetail } from "./managed-bun-path.ts";
import { type PRIVATE_SSH_FAILURES, PrivateSshError } from "./private-skill-error.ts";
import type { Provider } from "./provider.ts";
import { shellQuote } from "./shell-quote.ts";

export { PRIVATE_SSH_FAILURES, PrivateSshError } from "./private-skill-error.ts";
export { shellQuote } from "./shell-quote.ts";

interface SshOptions {
  onWarning?: (warning: GoldenBuildWarning) => void;
  mkdtemp?: typeof mkdtemp;
  rm?: typeof rm;
  writeFile?: typeof writeFile;
  chmod?: typeof chmod;
  readPublicKey?: (path: string) => Promise<string>;
  spawn?: typeof spawn;
}
/** Token is first stdin line. The one quoted remote command reads it before running the script. */
export async function sshStdinCheckout(
  provider: Provider,
  input: {
    sandboxId: string;
    buildId?: string;
    signal?: AbortSignal | undefined;
    token: string;
    script: string;
    timeoutMs?: number;
    repositories?: readonly string[];
    refs?: readonly string[];
  },
  deps: SshOptions = {},
): Promise<void> {
  await sshExchange(provider, input, deps, false, input.timeoutMs);
}

/** Private Skillpack transport: key and script use SSH stdin, never provider exec or argv. */
export async function sshPrivateSkillCommand(
  provider: Provider,
  input: { sandboxId: string; key: string; script: string },
  deps: SshOptions = {},
): Promise<string> {
  try {
    return await sshExchange(
      provider,
      { sandboxId: input.sandboxId, token: input.key, script: input.script },
      deps,
      true,
      600_000,
      true,
    );
  } catch (error) {
    if (error instanceof PrivateSshError) throw error;
    throw new PrivateSshError("skillpack_ssh_local_storage_failed");
  }
}

async function sshExchange(
  provider: Pick<Provider, "sshKey">,
  input: {
    sandboxId: string;
    buildId?: string;
    signal?: AbortSignal | undefined;
    token: string;
    script: string;
    repositories?: readonly string[];
    refs?: readonly string[];
  },
  deps: SshOptions,
  capture: boolean,
  timeoutMs = capture ? 30_000 : 600_000,
  privateTransport = false,
): Promise<string> {
  const fs = {
    mkdtemp: deps.mkdtemp ?? mkdtemp,
    rm: deps.rm ?? rm,
    writeFile: deps.writeFile ?? writeFile,
    chmod: deps.chmod ?? chmod,
  };
  const run = deps.spawn ?? spawn;
  const { signal } = input;
  signal?.throwIfAborted();
  const dir = await fs.mkdtemp(join(tmpdir(), "armada-ssh-"));
  const key = join(dir, "key"),
    known = join(dir, "known_hosts");
  let step: "keygen" | "local_storage" | "authorization" | "connection" | "remote" = "keygen";
  try {
    await command(run, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], "", {
      timeoutMs,
      signal,
    });
    step = "local_storage";
    await fs.chmod(key, 0o600);
    const pub = await (deps.readPublicKey ?? ((p: string) => Bun.file(p).text()))(`${key}.pub`);
    step = "authorization";
    signal?.throwIfAborted();
    const c = await provider.sshKey({ sandboxId: input.sandboxId, key: pub.trim() });
    step = "connection";
    const username = c.username === undefined ? "user" : c.username;
    if (username !== "user" && username !== "root") throw new GoldenError("setup_failed", "Invalid SSH username.");
    const ep = parseEndpoint(c.sshEndpoint);
    const knownText = knownLine(ep.host, ep.port, c.hostKey);
    step = "local_storage";
    await fs.writeFile(known, knownText, { mode: 0o600 });
    // ssh joins its command argv with spaces before the remote shell parses it. Keep this one
    // shell-quoted argument so semicolons cannot escape bash -c and turn `set +x` into a command.
    // The checkout script itself carries the cleanup trap; do not exec, which would discard it.
    const remote = shellQuote(
      "set +x; IFS= read -r ARMADA_GIT_TOKEN; IFS= read -r ARMADA_SSH_PUBLIC_KEY; export ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; " +
        (username === "root" ? "export HOME=/home/user; cd /home/user || exit 96; " : "") +
        "bash -s; status=$?; unset ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; history -c 2>/dev/null || true; exit $status",
    );
    step = "remote";
    return await command(
      run,
      "ssh",
      [
        "-i",
        key,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=30",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${known}`,
        "-o",
        "LogLevel=ERROR",
        "-p",
        ep.port,
        `${username}@${ep.host}`,
        "bash",
        "-c",
        remote,
      ],
      `${input.token}\n${pub.trim()}\n${input.script}`,
      {
        capture,
        timeoutMs,
        onWarning: deps.onWarning,
        privateTransport,
        repositories: input.repositories,
        refs: input.refs,
        buildId: input.buildId,
        signal,
      },
    );
  } catch (error) {
    if (!privateTransport || error instanceof PrivateSshError) throw error;
    throw new PrivateSshError(
      step === "local_storage"
        ? "skillpack_ssh_local_storage_failed"
        : step === "keygen"
          ? "skillpack_ssh_keygen_failed"
          : step === "authorization"
            ? "skillpack_ssh_authorization_failed"
            : step === "connection"
              ? "skillpack_ssh_connection_invalid"
              : "skillpack_ssh_remote_failed",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
function parseEndpoint(v: string) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(v) || /^([^:]+):(\d+)$/.exec(v);
  if (!m || Number(m[2] ?? 0) < 1 || Number(m[2] ?? 0) > 65535) throw new Error("Invalid SSH endpoint.");
  const host = m[1];
  const port = m[2];
  if (!host || !port) throw new Error("Invalid SSH endpoint.");
  return { host, port };
}
function knownLine(host: string, port: string, key: string) {
  if (/^\S+\s+(ssh-|ecdsa-|sk-)/.test(key)) return key.endsWith("\n") ? key : `${key}\n`;
  if (!/^(ssh-|ecdsa-|sk-)/.test(key)) throw new Error("Invalid SSH host key.");
  return `[${host}]:${port} ${key}\n`;
}
/** Only closed classes cross the guest stderr boundary; raw Git output may contain credentials. */
const GIT_FAILURE_MESSAGES = {
  auth_denied:
    "GitHub credentials were rejected. Grant your account and the Armada GitHub App read access, reconnect GitHub, then rebuild.",
  repository_not_found:
    "GitHub could not find or authorize the repository. Check its URL and grant your account and the Armada GitHub App read access, then rebuild.",
  branch_missing: "The requested branch was not found. Correct the branch, then rebuild.",
  transport_failed: "The Git transfer failed. Check connectivity and retry after the network is healthy.",
  lfs_failed: "Git LFS checkout failed. Check LFS availability and repository access, then rebuild.",
  destination_exists:
    "The checkout destination already exists. Choose a distinct repository directory or ask an administrator to inspect the builder.",
  storage_failed: "The builder could not write the checkout. Ask an administrator to check disk space and permissions.",
  unknown:
    "Git exited unsuccessfully without a recognized safe reason. Ask an administrator to inspect checkout diagnostics before retrying.",
} as const;

function safeGitRepository(repositories: readonly string[] | undefined, index: number): string {
  const repository = repositories?.[index - 1];
  return repository && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
    ? repository
    : `repository ${index}`;
}

const BUILD_FAILURE_RECORD = new RegExp(
  `^ARMADA_BUILD_FAILURE (${Object.keys(GOLDEN_SSH_RECEIPT_PHASES).join("|")}) ([0-9]{1,3})(?: ([0-9]{1,2}))?$`,
);

function command(
  spawnImpl: typeof spawn,
  file: string,
  args: string[],
  stdin: string,
  {
    capture = false,
    timeoutMs = capture ? 30_000 : 600_000,
    onWarning,
    privateTransport = false,
    repositories,
    refs,
    buildId,
    signal,
  }: {
    capture?: boolean;
    timeoutMs?: number;
    onWarning?: SshOptions["onWarning"];
    privateTransport?: boolean;
    repositories?: readonly string[] | undefined;
    refs?: readonly string[] | undefined;
    buildId?: string | undefined;
    signal?: AbortSignal | undefined;
  },
) {
  return new Promise<string>((resolve, reject) => {
    signal?.throwIfAborted();
    // Typed as the base ChildProcess, not the stdio-narrowed overload: which @types/node overload
    // that resolves to (and whether it still carries EventEmitter's own members) depends on the
    // exact @types/node version a workspace package without its own pin happens to get hoisted.
    const c: ChildProcess = spawnImpl(file, args, { stdio: ["pipe", capture ? "pipe" : "ignore", "pipe"] });
    let pending = "";
    let phase: keyof typeof GOLDEN_SSH_RECEIPT_PHASES = "ssh";
    let exitCode: string | undefined;
    let commandIndex: string | undefined;
    let collectorFailure: string | undefined;
    let gitFailure: { index: number; reason: keyof typeof GIT_FAILURE_MESSAGES } | undefined;
    let timedOut = false;
    let privateReason: (typeof PRIVATE_SSH_FAILURES)[number] | undefined;
    const output: Buffer[] = [];
    let bytes = 0,
      overflow = false;
    c.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) {
        overflow = true;
        output.length = 0;
        c.kill("SIGKILL");
      } else if (!overflow) output.push(Buffer.from(chunk));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      c.kill("SIGKILL");
    }, timeoutMs);
    const abort = () => c.kill("SIGKILL");
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
    c.stderr?.on("data", (d) => {
      // Stream only fixed protocol records; discard all tool stderr, including arbitrary secrets.
      pending += String(d);
      const lines = pending.split("\n");
      pending = (lines.pop() ?? "").slice(-256);
      for (const line of lines) {
        if (privateTransport) {
          const remote =
            /^ARMADA_PRIVATE_FAILURE (node_missing|flock_missing|home_unavailable|key_cleanup_failed)$/.exec(line);
          if (remote)
            privateReason = (
              {
                node_missing: "skillpack_ssh_node_missing",
                flock_missing: "skillpack_ssh_flock_missing",
                home_unavailable: "skillpack_ssh_home_unavailable",
                key_cleanup_failed: "skillpack_ssh_key_cleanup_failed",
              } as const
            )[remote[1] as "node_missing" | "flock_missing" | "home_unavailable" | "key_cleanup_failed"];
          else if (!privateReason) {
            if (
              line.includes("Host key verification failed") ||
              line.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")
            )
              privateReason = "skillpack_ssh_host_key_rejected";
            else if (line.includes("Permission denied (publickey"))
              privateReason = "skillpack_ssh_authentication_failed";
            else if (/kex_exchange_identification|Connection closed by/.test(line))
              privateReason = "skillpack_ssh_connection_failed";
            else if (
              /Connection refused|Connection timed out|Could not resolve hostname|Network is unreachable|Connection reset by peer/.test(
                line,
              )
            )
              privateReason = "skillpack_ssh_unreachable";
          }
          continue; // Never forward private SSH stderr, even build-looking records.
        }
        const match = BUILD_FAILURE_RECORD.exec(line);
        if (match) {
          phase = match[1] as keyof typeof GOLDEN_SSH_RECEIPT_PHASES;
          exitCode = match[2];
          commandIndex = match[3];
        }
        collectorFailure = outputCollectorFailureDetail(line) ?? collectorFailure;
        const git =
          /^ARMADA_GIT_FAILURE ([1-9]|1[0-6]) (auth_denied|repository_not_found|branch_missing|transport_failed|lfs_failed|destination_exists|storage_failed|unknown)$/.exec(
            line,
          );
        if (git) gitFailure = { index: Number(git[1]), reason: git[2] as keyof typeof GIT_FAILURE_MESSAGES };
        const warning = /^ARMADA_BUILD_WARNING skillpack (download_unavailable|user_local_only)$/.exec(line);
        if (warning)
          onWarning?.(
            warning[1] === "download_unavailable" ? "skillpack_download_unavailable" : "skillpack_user_local_only",
          );
        if (warning)
          console.warn(
            JSON.stringify({
              event: "golden_skillpack_warning",
              reason: warning[1],
              action:
                warning[1] === "user_local_only"
                  ? "use_user_local_cli"
                  : "allow_github_egress_and_rebuild_before_using_skills",
            }),
          );
      }
    });
    c.on("error", () => {
      cleanup();
      if (signal?.aborted) return reject(signal.reason);
      reject(
        privateTransport
          ? new PrivateSshError("skillpack_ssh_remote_failed")
          : new GoldenError("build_failed", `${file} could not start. Check server SSH tooling.`),
      );
    });
    c.stdin?.on?.("error", () => {
      /* Close/error owns the sanitized failure. */
    });
    c.on("close", (code: number | null) => {
      cleanup();
      if (signal?.aborted) return reject(signal.reason);
      if (code === 0 && !overflow) resolve(Buffer.concat(output).toString("utf8"));
      else {
        if (privateTransport) {
          reject(
            new PrivateSshError(
              timedOut
                ? "skillpack_ssh_timeout"
                : overflow
                  ? "skillpack_ssh_output_invalid"
                  : (privateReason ??
                    (code === 255 ? "skillpack_ssh_connection_failed" : "skillpack_ssh_remote_failed")),
            ),
          );
          return;
        }
        const reason = timedOut ? "timeout" : `exit_${exitCode ?? code ?? "signal"}`;
        if (!capture) console.error(JSON.stringify({ event: "golden_ssh_failed", buildId, phase, code: reason }));
        const missingRef = gitFailure?.reason === "branch_missing" ? refs?.[gitFailure.index - 1] : undefined;
        const gitMessage = gitFailure
          ? missingRef
            ? snapshotMissingRefMessage(safeGitRepository(repositories, gitFailure.index), missingRef)
            : `Could not clone ${safeGitRepository(repositories, gitFailure.index)}: ${GIT_FAILURE_MESSAGES[gitFailure.reason]}`
          : undefined;
        reject(
          new GoldenError(
            "build_failed",
            phase === "skillpack" && exitCode === "98"
              ? "skillpack_integrity_failed: native archive checksum or self-test failed; do not use this build."
              : `Golden build failed during ${phase} (${reason}). Check builder connectivity, permissions and package availability; retry after correction. The previous golden is retained.`,
            {
              safePhase: phase,
              safeMessage: timedOut
                ? `Build timed out during ${phase}.`
                : phase === "checkout"
                  ? gitMessage
                    ? `${gitMessage} Git exited ${exitCode ?? code ?? "unknown"}.`
                    : `Clone failed (exit ${exitCode ?? code ?? "unknown"}). Check the requested branches and GitHub access, then rebuild.`
                  : phase === "init" && commandIndex && Number(commandIndex) > 0
                    ? `Init command ${commandIndex} exited ${exitCode ?? code ?? "unknown"}. Correct the command, then rebuild.`
                    : phase === "output_collector"
                      ? `The sandbox output collector exited ${exitCode ?? code ?? "unknown"}. ${exitCode === "86" && collectorFailure ? `Failed check: ${collectorFailure}.` : "Verify the managed Bun executable, Linux glibc and /proc/self/fd before rebuilding."}`
                      : phase === "inline_scan"
                        ? `Secret scan exited ${exitCode ?? code ?? "unknown"} after finding token-shaped material; remove credentials from the repositories and builder before rebuilding.`
                        : `Build failed during ${phase} (${reason}). Check connectivity, permissions and package availability.`,
              ...(phase === "skillpack" && exitCode === "98"
                ? { safeReason: "skillpack_integrity_failed" as const }
                : {}),
            },
          ),
        );
      }
    });
    c.stdin?.end(stdin);
  });
}

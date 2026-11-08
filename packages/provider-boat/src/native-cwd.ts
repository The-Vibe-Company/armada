import type { ExecRequest } from "@armada/core";

export const NATIVE_HARNESS_PATHS = {
  codex: "/usr/local/bin/codex",
  claude: "/usr/local/bin/claude",
} as const;

type NativeHarness = keyof typeof NATIVE_HARNESS_PATHS;

/**
 * Installs Boat-image wrappers for the root-owned native harness entrypoints. The original image
 * executable is moved aside exactly once; subsequent installs replace only Armada's wrapper.
 */
export async function installNativeCwdWrapper(
  exec: (request: ExecRequest) => Promise<void>,
  sandboxId: string,
  harness: NativeHarness,
  cwd: string,
): Promise<void> {
  const path = NATIVE_HARNESS_PATHS[harness];
  const command = nativeCwdCommand(path, harness, cwd);
  await exec({
    sandboxId,
    timeoutSeconds: 60,
    command:
      (harness === "codex" ? "command -v python3 >/dev/null || exit 1; " : "") + nativeCwdInstallScript(path, command),
  });
}

/** Builds the VM wrapper command and always invokes the preserved image executable directly. */
export function nativeCwdCommand(path: string, harness: NativeHarness, cwd: string): string {
  const original = quote(`${path}.armada-original`);
  if (harness === "claude") return `cd -- ${quote(cwd)} && exec ${original} "$@"`;
  // Bash arrays preserve arbitrary runtime arguments without eval or shell re-parsing.
  const script = [
    "args=()",
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --) args+=("$@"); break ;;',
    '    -C|--cd) shift; if [ "$#" -gt 0 ]; then shift; fi; continue ;;',
    "    --cd=*) shift; continue ;;",
    "  esac",
    '  args+=("$1")',
    "  shift",
    "done",
    // Boat sends WORK_DIR as cwd in thread/start and thread/resume, overriding process cwd.
    // Only stdio app-server needs a protocol bridge; CLI invocations keep their normal transport.
    `if [ "\${args[0]-}" = app-server ]; then`,
    `  exec python3 -c ${quote(codexCwdBridge)} ${quote(cwd)} ${original} "\${args[@]}"`,
    "fi",
    `exec ${original} "\${args[@]}"`,
  ].join("\n");
  return `cd -- ${quote(cwd)} && exec /bin/bash -c ${quote(script)} -- "$@"`;
}

/** The command runs only inside a Boat sandbox, through its existing VM exec primitive. */
export function nativeCwdInstallScript(path: string, command: string): string {
  const payload = nativeCwdInstallPayload(path, command);
  return `if [ "$(id -u)" -eq 0 ]; then bash -c ${quote(payload)}; else exec sudo -n bash -c ${quote(payload)}; fi`;
}

function nativeCwdInstallPayload(path: string, command: string): string {
  const original = `${path}.armada-original`;
  const wrapper = `${path}.armada-wrapper`;
  return [
    "set -eu",
    `test -L ${quote(path)} || { echo 'native harness is unavailable' >&2; exit 1; }`,
    `test -x ${quote(path)} || { echo 'native harness is unavailable' >&2; exit 1; }`,
    `if [ ! -e ${quote(original)} ]; then mv -- ${quote(path)} ${quote(original)}; fi`,
    `test -x ${quote(original)} || { echo 'native harness original is unavailable' >&2; exit 1; }`,
    `tmp=$(mktemp ${quote(`${wrapper}.XXXXXX`)})`,
    `printf '%s\\n' '#!/bin/sh' ${quote(`exec /bin/sh -c ${quote(command)} -- "$@"`)} > "$tmp"`,
    'chmod 755 "$tmp"',
    `mv -f -- "$tmp" ${quote(wrapper)}`,
    `ln -sfn ${quote(wrapper)} ${quote(path)}`,
  ].join("; ");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Input-only bridge: responses, notifications and stderr go directly from Codex to Boat. */
const codexCwdBridge = `
import json, os, signal, subprocess, sys, threading

cwd = sys.argv[1]
args = sys.argv[2:]
# Boat currently uses stdio://. Do not silently launch an unprotected alternate transport.
for i, arg in enumerate(args):
    if arg.startswith("--listen=") and arg != "--listen=stdio://":
        sys.exit("Armada repository cwd requires Codex stdio transport")
    if arg == "--listen" and (i + 1 >= len(args) or args[i + 1] != "stdio://"):
        sys.exit("Armada repository cwd requires Codex stdio transport")
child = subprocess.Popen(args, stdin=subprocess.PIPE)
def forward_signal(sig, frame):
    try:
        child.send_signal(sig)
    except ProcessLookupError:
        pass
for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, forward_signal)
def relay():
    try:
        for line in sys.stdin.buffer:
            try:
                message = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                message = None
            if (isinstance(message, dict)
                    and message.get("method") in ("thread/start", "thread/resume", "turn/start")
                    and isinstance(message.get("params"), dict)):
                message["params"]["cwd"] = cwd
                line = (json.dumps(message, ensure_ascii=True) + "\\n").encode()
            child.stdin.write(line)
            child.stdin.flush()
    except (BrokenPipeError, OSError):
        pass
    finally:
        try:
            child.stdin.close()
        except OSError:
            pass
threading.Thread(target=relay, daemon=True).start()
code = child.wait()
if code < 0:
    if -code not in (signal.SIGKILL, signal.SIGSTOP):
        signal.signal(-code, signal.SIG_DFL)
    os.kill(os.getpid(), -code)
sys.exit(code)
`;

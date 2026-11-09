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
  cwd?: string,
): Promise<void> {
  const path = NATIVE_HARNESS_PATHS[harness];
  const command = nativeCwdCommand(path, harness, cwd);
  await exec({
    sandboxId,
    timeoutSeconds: 60,
    command:
      (harness === "codex" ? "python3 -c 'import tomllib' >/dev/null || exit 1; " : "") +
      nativeCwdInstallScript(path, command, cwd),
  });
}

/** Builds the VM wrapper command and always invokes the preserved image executable directly. */
export function nativeCwdCommand(path: string, harness: NativeHarness, cwd?: string): string {
  const original = quote(`${path}.armada-original`);
  if (harness === "claude")
    return [
      `selected=${quote(cwd ?? "")}`,
      `if [ -z "$selected" ] && [ -f ${quote(`${path}.armada-cwd`)} ]; then selected=$(cat -- ${quote(`${path}.armada-cwd`)}); fi`,
      'if [ -n "$selected" ]; then cd -- "$selected" || exit 1; fi',
      `if [ -x "$HOME/.armada/github-native-proxy" ]; then exec "$HOME/.armada/github-native-proxy" ${original} "$@"; fi`,
      `exec ${original} "$@"`,
    ].join("; ");
  // Bash arrays preserve arbitrary runtime arguments without eval or shell re-parsing.
  const script = [
    `selected=${quote(cwd ?? "")}`,
    `if [ -z "$selected" ] && [ -f ${quote(`${path}.armada-cwd`)} ]; then selected=$(cat -- ${quote(`${path}.armada-cwd`)}); fi`,
    'if [ -n "$selected" ]; then cd -- "$selected" || exit 1; fi',
    "args=()",
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --) args+=("$@"); break ;;',
    '    -C|--cd) if [ -z "$selected" ]; then args+=("$1"); shift; if [ "$#" -gt 0 ]; then args+=("$1"); shift; fi; continue; fi; shift; if [ "$#" -gt 0 ]; then shift; fi; continue ;;',
    '    --cd=*) if [ -z "$selected" ]; then args+=("$1"); fi; shift; continue ;;',
    "  esac",
    '  args+=("$1")',
    "  shift",
    "done",
    // Boat sends WORK_DIR as cwd in thread/start and thread/resume, overriding process cwd.
    // Only stdio app-server needs a protocol bridge; CLI invocations keep their normal transport.
    `if [ "\${args[0]-}" = app-server ]; then`,
    `  exec python3 -c ${quote(codexCwdBridge)} "$selected" ${original} "\${args[@]}"`,
    "fi",
    `exec ${original} "\${args[@]}"`,
  ].join("\n");
  return `exec /bin/bash -c ${quote(script)} -- "$@"`;
}

/** The command runs only inside a Boat sandbox, through its existing VM exec primitive. */
export function nativeCwdInstallScript(path: string, command: string, cwd?: string): string {
  const payload = nativeCwdInstallPayload(path, command, cwd);
  return `if [ "$(id -u)" -eq 0 ]; then bash -c ${quote(payload)}; else exec sudo -n bash -c ${quote(payload)}; fi`;
}

function nativeCwdInstallPayload(path: string, command: string, cwd?: string): string {
  const original = `${path}.armada-original`;
  const wrapper = `${path}.armada-wrapper`;
  return [
    "set -eu",
    "umask 077",
    "command -v flock >/dev/null || exit 1",
    `test ! -L ${quote(`${path}.armada-install.lock`)}`,
    `test ! -e ${quote(`${path}.armada-install.lock`)} || test -f ${quote(`${path}.armada-install.lock`)}`,
    `exec 9> ${quote(`${path}.armada-install.lock`)}`,
    "flock -x -w 30 9 || { echo 'native harness installer is busy' >&2; exit 1; }",
    ...(cwd === undefined
      ? []
      : [
          `test ! -L ${quote(`${path}.armada-cwd`)}`,
          `printf %s ${quote(cwd)} > ${quote(`${path}.armada-cwd`)}`,
          `chmod 644 ${quote(`${path}.armada-cwd`)}`,
        ]),
    `test -L ${quote(path)} || { echo 'native harness is unavailable' >&2; exit 1; }`,
    `test -x ${quote(path)} || { echo 'native harness is unavailable' >&2; exit 1; }`,
    `if [ ! -e ${quote(original)} ] && [ ! -L ${quote(original)} ]; then mv -n -- ${quote(path)} ${quote(original)}; fi`,
    `test -x ${quote(original)} || { echo 'native harness original is unavailable' >&2; exit 1; }`,
    `original_resolved=$(readlink -f -- ${quote(original)})`,
    `test "$original_resolved" != ${quote(wrapper)} || { echo 'native harness original is invalid' >&2; exit 1; }`,
    `tmp=$(mktemp ${quote(`${wrapper}.XXXXXX`)})`,
    `printf '%s\\n' '#!/bin/sh' ${quote(`exec /bin/sh -c ${quote(command)} -- "$@"`)} > "$tmp"`,
    'chmod 755 "$tmp"',
    `mv -f -- "$tmp" ${quote(wrapper)}`,
    `ln -s -- ${quote(wrapper)} "$tmp.link"`,
    `mv -Tf -- "$tmp.link" ${quote(path)}`,
  ].join("; ");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Transparent stdio bridge: only private reload replies are consumed; peer traffic and stderr are preserved. */
const codexCwdBridge = `
import json, os, signal, stat, subprocess, sys, threading, uuid, socket, http.client

class ManagedMcpOverridesError(Exception):
    pass

def fresh_mcp(params):
    import tomllib
    home = os.path.expanduser("~")
    directory = os.path.join(home, ".armada")
    manifest = os.path.join(directory, "mcp-codex-owned.json")
    if not os.path.lexists(manifest):
        return
    def check(path, directory=False):
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode) or (directory and not stat.S_ISDIR(info.st_mode)) or (not directory and not stat.S_ISREG(info.st_mode)):
            raise ValueError("Unsafe native MCP path")
        if info.st_uid != os.getuid() or (not directory and info.st_mode & 0o077):
            raise ValueError("Unsafe native MCP permissions")
    check(directory, True); check(manifest)
    with open(manifest) as source:
        names = json.load(source)
    if not isinstance(names, list) or any(not isinstance(n,str) or not n.startswith("armada_") for n in names):
        raise ValueError("Invalid native MCP manifest")
    codex_dir = os.path.join(home, ".codex")
    config_path = os.path.join(codex_dir, "config.toml")
    check(codex_dir, True); check(config_path)
    with open(config_path, "rb") as source:
        current = tomllib.load(source).get("mcp_servers", {})
    return {name:current.get(name, {"command":"/usr/bin/false", "enabled":False}) for name in names}

def github_safe(line):
    locator=os.path.join(os.path.expanduser("~"),".armada","github-socket")
    if not os.path.lexists(locator): return line
    info=os.lstat(locator)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077 or info.st_size>4096: raise ValueError("GitHub redaction unavailable")
    with open(locator) as source: target=source.read().strip()
    if not target.startswith(os.path.join(os.path.expanduser("~"),".armada","github-")) or not target.endswith("/redact.sock"): raise ValueError("GitHub redaction unavailable")
    class Private(http.client.HTTPConnection):
        def connect(self):
            self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(10);self.sock.connect(target)
    connection=Private("private")
    connection.request("POST","/redact",line,{"Content-Type":"application/octet-stream"})
    response=connection.getresponse();result=response.read(262145)
    if response.status!=200 or len(result)>262144: raise ValueError("GitHub redaction unavailable")
    connection.close();return result

cwd = sys.argv[1]
args = sys.argv[2:]
# Boat currently uses stdio://. Do not silently launch an unprotected alternate transport.
for i, arg in enumerate(args):
    if arg.startswith("--listen=") and arg != "--listen=stdio://":
        sys.exit("Armada repository cwd requires Codex stdio transport")
    if arg == "--listen" and (i + 1 >= len(args) or args[i + 1] != "stdio://"):
        sys.exit("Armada repository cwd requires Codex stdio transport")
child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
output_lock = threading.Lock()
pending_reload = {}
def output(line):
    try: line=github_safe(line)
    except Exception:
        child.terminate();return
    with output_lock:
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()
def receive():
    for line in child.stdout:
        try:
            message = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            message = None
        if isinstance(message,dict) and "method" not in message and isinstance(message.get("id"),str):
            pending = pending_reload.pop(message.get("id"),None)
            if pending is not None:
                pending[1].append("result" in message and "error" not in message)
                pending[0].set()
                continue
        output(line)
receiver = threading.Thread(target=receive, daemon=True)
receiver.start()
def github_stderr():
    if child.stderr is None: return
    try:
        for line in child.stderr:
            sys.stderr.buffer.write(github_safe(line));sys.stderr.buffer.flush()
    except Exception: child.terminate()
github_errors=threading.Thread(target=github_stderr,daemon=True)
github_errors.start()
def reload_mcp():
    if len(pending_reload) >= 128:
        return False
    request_id = "armada-mcp-reload-" + uuid.uuid4().hex
    event, result = threading.Event(), []
    pending_reload[request_id] = (event,result)
    child.stdin.write((json.dumps({"id":request_id,"method":"config/mcpServer/reload","params":None}) + "\\n").encode())
    child.stdin.flush()
    success = event.wait(10) and result == [True]
    # Keep a timed-out ID registered so a late control reply can never escape to Boat.
    if success:
        pending_reload.pop(request_id,None)
    return success
last_mcp = None
def forward_signal(sig, frame):
    try:
        child.send_signal(sig)
    except ProcessLookupError:
        pass
for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, forward_signal)
def relay():
    global last_mcp
    try:
        for line in sys.stdin.buffer:
            try:
                message = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                message = None
            if (isinstance(message, dict)
                    and message.get("method") in ("thread/start", "thread/resume", "turn/start")
                    and isinstance(message.get("params"), dict)):
                if cwd:
                    message["params"]["cwd"] = cwd
                try:
                    current_mcp = fresh_mcp(message["params"])
                    if current_mcp is not None:
                        # Never introduce managed session overrides: they mask disk reload.
                        # Reject an explicit owned-name collision, without deleting any
                        # customer header or changing any unmanaged override.
                        config = message["params"].get("config")
                        if isinstance(config,dict):
                            # Codex turns each config key into a CLI override path
                            # using split('.'); match an EXACT owned server segment.
                            for key, value in config.items():
                                parts = key.split(".")
                                if parts[0] != "mcp_servers":
                                    continue
                                if len(parts) > 1:
                                    if parts[1] in current_mcp:
                                        raise ManagedMcpOverridesError()
                                elif isinstance(value,dict):
                                    if any(name in value for name in current_mcp):
                                        raise ManagedMcpOverridesError()
                                elif current_mcp:
                                    # A scalar/array/null would replace the whole
                                    # owned table rather than add unmanaged entries.
                                    raise ManagedMcpOverridesError()
                        if last_mcp is not None and current_mcp != last_mcp:
                            if not reload_mcp():
                                raise ValueError("Native MCP refresh refused")
                        last_mcp = current_mcp
                except ManagedMcpOverridesError:
                    if "id" in message:
                        output((json.dumps({"id":message["id"],"error":{"code":-32602,"message":"Inline managed MCP configuration is unsupported; start a new native session with disk-inherited MCP configuration."}})+"\\n").encode())
                    continue
                except Exception:
                    if "id" in message:
                        output((json.dumps({"id":message["id"],"error":{"code":-32603,"message":"Native MCP configuration refresh failed; retry the turn."}})+"\\n").encode())
                    continue
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
receiver.join(timeout=2)
github_errors.join(timeout=2)
if code < 0:
    if -code not in (signal.SIGKILL, signal.SIGSTOP):
        signal.signal(-code, signal.SIG_DFL)
    os.kill(os.getpid(), -code)
sys.exit(code)
`;

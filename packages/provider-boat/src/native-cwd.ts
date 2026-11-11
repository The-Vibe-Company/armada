import { deflateSync } from "node:zlib";
import type { ExecRequest } from "@armada/core";
import { claudeMcpBridge } from "./native-claude-mcp.ts";
import { NATIVE_USAGE_BOOTSTRAP } from "./native-usage.ts";

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
  managedClaudeMcp = false,
): Promise<void> {
  const path = NATIVE_HARNESS_PATHS[harness];
  const command = nativeCwdCommand(path, harness, cwd, managedClaudeMcp);
  await exec({
    sandboxId,
    timeoutSeconds: 60,
    command:
      (harness === "codex"
        ? "python3 -I -c 'import tomllib' >/dev/null || exit 1; "
        : managedClaudeMcp
          ? "python3 -I -c 'import json,os,signal,stat,subprocess,threading,uuid' >/dev/null || exit 1; "
          : "") + nativeCwdInstallScript(path, command, cwd, managedClaudeMcp),
  });
}

/** Builds the VM wrapper command and always invokes the preserved image executable directly. */
export function nativeCwdCommand(path: string, harness: NativeHarness, cwd?: string, managedClaudeMcp = false): string {
  const original = quote(`${path}.armada-original`);
  if (harness === "claude")
    return readableWrapper(
      harness,
      [
        `selected=${quote(cwd ?? "")}`,
        `if [ -z "$selected" ] && [ -f ${quote(`${path}.armada-cwd`)} ]; then selected=$(cat -- ${quote(`${path}.armada-cwd`)}); fi`,
        'if [ -n "$selected" ]; then cd -- "$selected" || exit 1; fi',
        `if [ -x "$HOME/.armada/github-native-proxy" ]; then exec "$HOME/.armada/github-native-proxy" ${managedClaudeMcp ? `python3 -I -c ${quote(claudeMcpBridge)} ` : ""}${original} "$@"; fi`,
        `exec ${managedClaudeMcp ? `python3 -I -c ${quote(claudeMcpBridge)} ` : ""}${original} "$@"`,
      ].join("; "),
    );
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
    `  exec python3 -I -c ${quote(compressedCodexBridge())} "$selected" ${original} "\${args[@]}"`,
    "fi",
    `exec ${original} "\${args[@]}"`,
  ].join("\n");
  return readableWrapper(harness, `exec /bin/bash -c ${quote(script)} -- "$@"`);
}

/** The command runs only inside a Boat sandbox, through its existing VM exec primitive. */
export function nativeCwdInstallScript(path: string, command: string, cwd?: string, managedClaudeMcp = false): string {
  const payload = nativeCwdInstallPayload(path, command, cwd, managedClaudeMcp);
  return `if [ "$(id -u)" -eq 0 ]; then bash -c ${quote(payload)}; else exec sudo -n bash -c ${quote(payload)}; fi`;
}

function nativeCwdInstallPayload(
  path: string,
  command: string,
  cwd: string | undefined,
  managedClaudeMcp: boolean,
): string {
  const original = `${path}.armada-original`;
  const wrapper = `${path}.armada-wrapper`;
  const managedMarker = `${path}.armada-managed-mcp`;
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
    `test ! -L ${quote(managedMarker)}`,
    `test ! -e ${quote(managedMarker)} || { test -f ${quote(managedMarker)} && test "$(stat -c %u ${quote(managedMarker)})" = "$(id -u)" && test "$(stat -c %a ${quote(managedMarker)})" = 644; }`,
    // A generic GitHub/pre-prompt install may update cwd, never downgrade a
    // validated managed wrapper. Only a managed installation creates this marker.
    ...(managedClaudeMcp
      ? []
      : [
          `if [ -f ${quote(managedMarker)} ]; then test "$(readlink -f -- ${quote(path)})" = ${quote(wrapper)} && test ! -L ${quote(wrapper)} && test -f ${quote(wrapper)} && test "$(stat -c %u ${quote(wrapper)})" = "$(id -u)" && test "$(stat -c %a ${quote(wrapper)})" = 755 && test "$(sha256sum ${quote(wrapper)} | cut -d ' ' -f 1)" = "$(cat ${quote(managedMarker)})" && exit 0; exit 1; fi`,
        ]),
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
    ...(managedClaudeMcp
      ? [`sha256sum ${quote(wrapper)} | cut -d ' ' -f 1 > ${quote(managedMarker)}`, `chmod 644 ${quote(managedMarker)}`]
      : []),
  ].join("; ");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Transparent stdio bridge: only private reload replies are consumed; peer traffic and stderr are preserved. */
const codexCwdBridge = `
import fcntl, json, os, signal, stat, subprocess, sys, threading, time, uuid, socket, http.client
usage = {"__name__":"armada_native_usage"}
exec(${JSON.stringify(NATIVE_USAGE_BOOTSTRAP)},usage)
usage_pending = {}
usage_fresh = set()
usage_tickets = {}

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

def github_safe_once(line):
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

github_stopping=threading.Event()
def github_safe(line):
    warned=False
    while True:
        try: return github_safe_once(line)
        except Exception:
            if github_stopping.is_set(): return b''
            if not warned:
                sys.stderr.write("Managed GitHub output paused (redaction unavailable).\\n");sys.stderr.flush();warned=True
            # Preserve protocol bytes and apply backpressure until redaction recovers.
            # GitHub IPC failure must never terminate the native app-server.
            time.sleep(0.1)

cwd = sys.argv[1]
args = sys.argv[2:]
# Boat currently uses stdio://. Do not silently launch an unprotected alternate transport.
for i, arg in enumerate(args):
    if arg.startswith("--listen=") and arg != "--listen=stdio://":
        sys.exit("Armada repository cwd requires Codex stdio transport")
    if arg == "--listen" and (i + 1 >= len(args) or args[i + 1] != "stdio://"):
        sys.exit("Armada repository cwd requires Codex stdio transport")
native_home = os.path.join(os.path.expanduser("~"), ".codex")
managed_marker = os.path.join(native_home, ".armada-managed-native")
managed = os.path.lexists(managed_marker)
writer_fd = None
def admission():
    info = os.lstat(managed_marker)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        raise ValueError("Unsafe native admission")
    fd = os.open(managed_marker, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        return os.read(fd, 7) == b"active"
    finally:
        os.close(fd)
if managed:
    info = os.lstat(native_home)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        sys.exit("Unsafe native home")
    writer_fd = os.open(os.path.join(native_home, ".armada-native-writer.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(writer_fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        sys.exit("Unsafe native writer lock")
    try:
        fcntl.flock(writer_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit("native_auth_writer_busy")
    if not admission():
        sys.exit("native_auth_state_sync_pending")
native_secrets = set()
def native_registry():
    if not managed:
        return
    try:
        fd = os.open(os.path.join(native_home, "auth.json"), os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > 65536:
            raise ValueError("Unsafe native auth")
        raw = os.read(fd, 65537)
        if len(raw) > 65536:
            raise ValueError("Unsafe native auth")
        value = json.loads(raw)
        tokens = value.get("tokens")
        if not isinstance(tokens, dict) or any(not isinstance(tokens.get(key),str) for key in ("access_token","refresh_token","account_id")):
            raise ValueError("Unsafe native auth")
        def leaves(item):
            if isinstance(item,str) and item:
                native_secrets.add(item)
            elif isinstance(item,dict):
                for child in item.values(): leaves(child)
            elif isinstance(item,list):
                for child in item: leaves(child)
        leaves(tokens)
        native_secrets.add(raw.decode())
    finally:
        os.close(fd)
def native_safe(value):
    if isinstance(value,str):
        for secret in sorted(native_secrets,key=len,reverse=True): value = value.replace(secret,"***")
        return value
    if isinstance(value,list): return [native_safe(item) for item in value]
    if isinstance(value,dict): return {native_safe(key):native_safe(item) for key,item in value.items()}
    return value
native_registry()
native_stopping = threading.Event()
child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL if managed else subprocess.PIPE, start_new_session=managed,
                         pass_fds=(writer_fd,) if managed else ())
if managed:
    # The native group retains flock even if this bridge is SIGKILLed. Record its
    # physical identity so private pause can safely quiesce that orphan group.
    with open("/proc/" + str(child.pid) + "/stat") as source:
        native_start = source.read().rsplit(")", 1)[1].strip().split()[19]
    with open("/proc/sys/kernel/random/boot_id") as source:
        native_boot = source.read().strip()
    record_fd = os.open(os.path.join(native_home, ".armada-native-writer.json"), os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(record_fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        os.killpg(child.pid, signal.SIGKILL)
        sys.exit("Unsafe native writer identity")
    try:
        os.ftruncate(record_fd, 0)
        os.write(record_fd, json.dumps({"pid":child.pid,"start":native_start,"boot":native_boot}).encode())
        os.fsync(record_fd)
    finally:
        os.close(record_fd)
if managed:
    def watch_admission():
        while child.poll() is None:
            try:
                if admission():
                    time.sleep(0.05)
                    continue
            except Exception:
                pass
            native_stopping.set()
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            return
    threading.Thread(target=watch_admission, daemon=True).start()
output_lock = threading.Lock()
pending_reload = {}
# Boat can submit another prompt before turn/start has returned its native turn ID.
# Do not let overlapping starts/steers reach Codex during that admission window.
native_pending = {}
native_request = threading.Event()
native_replied = False
starting_turns = {}
starting_lock = threading.Lock()
def output(line):
    if managed:
        try:
            native_registry()
            try:
                line = (json.dumps(native_safe(json.loads(line))) + "\\n").encode()
            except (ValueError, UnicodeDecodeError):
                line = native_safe(line.decode()).encode()
        except Exception:
            try: os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            return
    try: line=github_safe(line)
    except Exception:
        if managed:
            try: os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError: pass
        else: child.terminate()
        return
    with output_lock:
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()
def receive():
    global native_replied
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
        if isinstance(message,dict):
            request = usage_pending.pop(str(message.get("id")),None)
            result = message.get("result",{})
            if request and request[0] in ("thread/start","thread/resume") and isinstance(result,dict):
                thread = result.get("thread",{})
                if isinstance(thread,dict) and isinstance(thread.get("id"),str) and request[0]=="thread/start": usage_fresh.add(thread["id"])
            if message.get("method") in ("turn/started","turn/completed"):
                params = message.get("params",{})
                thread = params.get("threadId") if isinstance(params,dict) else None
                turn = params.get("turn",{}) if isinstance(params,dict) else {}
                native_turn = turn.get("id") if isinstance(turn,dict) else None
                ticket = usage_tickets.get(thread)
                if ticket and isinstance(native_turn,str):
                    try:
                        if message["method"]=="turn/started": usage["start"](ticket,native_turn)
                        else:
                            usage["terminal"](ticket,native_turn)
                            usage_tickets.pop(thread,None)
                    except Exception: pass
        if isinstance(message, dict) and "method" not in message and "id" in message:
            with starting_lock:
                starting_turns.pop(message["id"], None)
                if message["id"] in native_pending:
                    native_replied = True
                    native_pending.clear()
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
    native_stopping.set()
    github_stopping.set()
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
                    and message.get("method") in ("turn/start", "turn/steer")
                    and isinstance(message.get("params"), dict)):
                with starting_lock:
                    busy = message["params"].get("threadId") in starting_turns.values()
                if busy:
                    if "id" in message:
                        output((json.dumps({"id":message["id"],"error":{"code":-32000,"message":"turn_starting: wait for the current turn to start before sending another message."}})+"\\n").encode())
                    continue
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
            if isinstance(message,dict):
                method=message.get("method")
                if method in ("thread/start","thread/resume"):
                    usage_pending[str(message.get("id"))]=(method,None)
                if method=="turn/start":
                    params=message.get("params",{})
                    thread=params.get("threadId") if isinstance(params,dict) else None
                    if isinstance(thread,str):
                        try:
                            ticket=usage["capture"]("codex",thread,thread in usage_fresh,usage["prompt_digest"](params.get("input")),usage["INPUT_ENCODING"])
                            usage_fresh.discard(thread)
                            if ticket: usage_tickets[thread]=ticket
                        except Exception: pass
            native_registry()
            if isinstance(message, dict) and "method" in message and "id" in message:
                with starting_lock:
                    if not native_replied:
                        native_pending[message["id"]] = message["method"]
                        native_request.set()
                    if message["method"] == "turn/start":
                        starting_turns[message["id"]] = message["params"].get("threadId")
            child.stdin.write(line)
            child.stdin.flush()
    except Exception:
        if managed:
            try: os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError: pass
    finally:
        try:
            child.stdin.close()
        except OSError:
            pass
threading.Thread(target=relay, daemon=True).start()
code = child.wait()
if managed:
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    # Keep the OS admission lock until all members of the isolated native group
    # are gone. A stuck writer makes private capture time out, never falsely ACK.
    def group_live():
        for name in os.listdir("/proc"):
            if not name.isdigit():
                continue
            try:
                with open("/proc/" + name + "/stat") as source:
                    fields = source.read().rsplit(")", 1)[1].strip().split()
                if int(fields[2]) == child.pid and fields[0] not in ("Z", "X"):
                    return True
            except FileNotFoundError:
                continue
        return False
    while group_live():
        time.sleep(0.01)
receiver.join()
github_errors.join()
# A native executable that dies before its first RPC reply never booted.
# Keep the pipe alive briefly if it died BEFORE Boat sent initialize, so the
# caller still gets a response with its own ID rather than a raw exit signal.
if code != 0 and not native_replied and not native_stopping.is_set():
    diagnosis = "The agent runtime could not start in this sandbox. Relaunch in a new sandbox."
    sys.stderr.write(diagnosis + "\\n")
    sys.stderr.flush()
    native_request.wait(1)
    with starting_lock:
        startup_pending = list(native_pending)
    for request_id in startup_pending:
        output((json.dumps({"id":request_id,"error":{"code":-32603,"message":diagnosis}})+"\\n").encode())
    sys.exit(1)
if code < 0:
    if -code not in (signal.SIGKILL, signal.SIGSTOP):
        signal.signal(-code, signal.SIG_DFL)
    os.kill(os.getpid(), -code)
sys.exit(code)
`;

/** Values are only loaded by the native workload, never the VM exec environment. */
function readableWrapper(harness: NativeHarness, command: string): string {
  const loader = `import os,sys,json,stat
p="/run/armada-readable-variables/"+sys.argv[1]+".json"
e=dict(os.environ)
try:
 f=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(f)
  assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022
  with os.fdopen(f) as r: e.update(json.load(r))
 except BaseException:
  raise
except FileNotFoundError: pass
os.execve("/bin/bash",["bash","-c",sys.argv[2],"--"]+sys.argv[3:],e)`;
  // Ordinary native Claude retains its no-Python path when no values were delivered.
  return `if [ -f ${quote(`/run/armada-readable-variables/${harness}.json`)} ]; then exec /usr/bin/python3 -I -c ${quote(loader)} ${quote(harness)} ${quote(command)} "$@"; fi; ${command}`;
}

/** Keep the nested installer below Linux's per-argument limit. */
function compressedCodexBridge(): string {
  return `import base64,zlib;exec(zlib.decompress(base64.b64decode("${deflateSync(codexCwdBridge).toString("base64")}")))`;
}

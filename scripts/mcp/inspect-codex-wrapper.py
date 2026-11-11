#!/usr/bin/env python3
"""Private operator receipt. Inspect ONLY selected native kernel argv/metadata.
No environments, auth/config values, history, argv, PIDs or hashes are printed.
Usage: python3 inspect-codex-wrapper.py NATIVE_PID [--expected-native-binary PATH]
"""
import json
import base64
import binascii
import zlib
import glob
import os
import sys
import stat

def static_code(arg):
    """Decode only Armada's inert compression envelope; never execute inspected argv."""
    prefix = b'import base64,zlib;exec(zlib.decompress(base64.b64decode("'
    suffix = b'")))'
    if not arg.startswith(prefix):
        return arg
    if len(arg) > 128 * 1024 or not arg.endswith(suffix):
        return b""
    try:
        packed = base64.b64decode(arg[len(prefix):-len(suffix)], validate=True)
        decoder = zlib.decompressobj()
        code = decoder.decompress(packed, 256 * 1024 + 1)
        if len(code) > 256 * 1024 or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            return b""
        return code
    except (binascii.Error, zlib.error, ValueError):
        return b""


result = dict(nativeAppServerFound=False, inspectionComplete=True,
              nativeExecutableMatchesInstalledBinary=False, nativeHasBridgeAncestor=False, nativeHasFreshReloadBridgeAncestor=False,
              nativeHasLegacyInjectionBridgeAncestor=False, nativeHasNestedBridges=False,
              installedEntrypointIsManagedWrapper=False, originalResolvesManagedWrapper=False)
try:
    if len(sys.argv) not in (2, 4) or (len(sys.argv) == 4 and sys.argv[2] != "--expected-native-binary"):
        raise ValueError()
    expected_binary = os.path.realpath(sys.argv[3]) if len(sys.argv) == 4 else None
    selected = int(sys.argv[1])
    if selected <= 1:
        raise ValueError()
    wrapper = "/usr/local/bin/codex.armada-wrapper"
    result["installedEntrypointIsManagedWrapper"] = os.path.realpath("/usr/local/bin/codex") == wrapper
    result["originalResolvesManagedWrapper"] = os.path.realpath("/usr/local/bin/codex.armada-original") == wrapper
    todo, seen = [selected], set()
    natives = []
    while todo and len(seen) < 128:
        pid = todo.pop()
        if pid in seen:
            continue
        seen.add(pid)
        with open("/proc/%d/cmdline" % pid, "rb") as source:
            argv = source.read(1024 * 1024).split(b"\0")
        if os.path.basename(os.readlink("/proc/%d/exe" % pid)) == "codex" and b"app-server" in argv:
            natives.append(pid)
        with open("/proc/%d/task/%d/children" % (pid, pid)) as source:
            todo.extend(map(int, source.read().split()))
    result["nativeAppServerFound"] = bool(natives)
    installed_inodes = set()
    if expected_binary is not None:
        info = os.stat(expected_binary)
        if not stat.S_ISREG(info.st_mode) or not os.access(expected_binary, os.X_OK):
            raise ValueError()
        # Explicit fixture identity REPLACES defaults, never broadens the match.
        installed_inodes.add((info.st_dev, info.st_ino))
    else:
        for pattern in ["/opt/ascii-agent/node_modules/@openai/codex-*/vendor/*/bin/codex",
                        "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-*/vendor/*/bin/codex",
                        "/usr/local/lib/node_modules/@openai/codex/vendor/*/bin/codex"]:
            for candidate in glob.glob(pattern):
                info = os.stat(candidate)
                installed_inodes.add((info.st_dev, info.st_ino))
    matches = []
    for pid in natives:
        info = os.stat("/proc/%d/exe" % pid)
        matches.append((info.st_dev, info.st_ino) in installed_inodes)
    result["nativeExecutableMatchesInstalledBinary"] = bool(matches) and all(matches)
    receipts = []
    for pid in natives:
        bridges, fresh, legacy = 0, False, False
        for _ in range(16):
            with open("/proc/%d/cmdline" % pid, "rb") as source:
                args = source.read(1024 * 1024).split(b"\0")
            # Only static code signatures; never emit any actual argument.
            executable = os.path.basename(os.readlink("/proc/%d/exe" % pid))
            for arg in (args[1:] if executable.startswith("python") else []):
                arg = static_code(arg)
                if b"def fresh_mcp(" in arg:
                    bridges += 1
                    fresh |= b"def reload_mcp(" in arg and b"config/mcpServer/reload" in arg
                    legacy |= b'overrides[name] = current.get' in arg
            if bridges and not executable.startswith("python"):
                break
            with open("/proc/%d/stat" % pid) as source:
                parent = int(source.read().rsplit(")", 1)[1].split()[1])
            if parent <= 1:
                break
            pid = parent
        receipts.append((bridges, fresh, legacy))
    if receipts:
        result["nativeHasBridgeAncestor"] = all(n > 0 for n, _, _ in receipts)
        result["nativeHasFreshReloadBridgeAncestor"] = all(f for _, f, _ in receipts)
        result["nativeHasLegacyInjectionBridgeAncestor"] = any(l for _, _, l in receipts)
        result["nativeHasNestedBridges"] = any(n > 1 for n, _, _ in receipts)
except (OSError, ValueError, IndexError):
    result["inspectionComplete"] = False
print(json.dumps(result, sort_keys=True))

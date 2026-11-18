/** Declared sandbox outputs (#2570): one fixed directory, bounded snapshot, no caller-supplied path. */

import {
  OUTPUT_DIRECTORY,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_ENTRIES,
  OUTPUT_MAX_FILES,
  validOutputName,
} from "./sandbox-output-limits.ts";
import { shellQuote } from "./shell-quote.ts";

export {
  OUTPUT_DIRECTORY,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_ENTRIES,
  OUTPUT_MAX_FILES,
} from "./sandbox-output-limits.ts";

/** One declared output file as read by a provider. Callers still validate with `admitOutputs`. */
export interface OutputFile {
  name: string;
  bytes: Uint8Array;
}

// The managed Modal image ships Bun under /opt. Boat's golden baseline also installs Bun.
// Use only fixed paths and clear the environment before starting the collector. In a privileged
// exec context, do not fall back to the agent's home executable.
const collectorShell = (program: string) => `cd / || exit 5
uid=$(/usr/bin/id -u) || exit 86
protected_bun() {
  for component in /opt /opt/armada /opt/armada/runtime-bun /opt/armada/runtime-bun/bun; do
    [ ! -L "$component" ] || return 1
    metadata=$(/usr/bin/stat -c '%u %a' -- "$component") || return 1
    set -- $metadata
    [ "$1" = 0 ] && [ "$((0$2 & 022))" = 0 ] || return 1
  done
  [ -f /opt/armada/runtime-bun/bun ] && [ -x /opt/armada/runtime-bun/bun ]
}
if protected_bun 2>/dev/null; then
  bun=/opt/armada/runtime-bun/bun
elif [ "$uid" = 0 ]; then
  exit 86
elif [ -x /usr/local/bin/bun ]; then
  bun=/usr/local/bin/bun
elif [ -x /usr/bin/bun ]; then
  bun=/usr/bin/bun
elif [ -x /home/user/.bun/bin/bun ]; then
  bun=/home/user/.bun/bin/bun
else
  exit 86
fi
exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin "$bun" --no-env-file --no-install -e ${shellQuote(program)}`;

// Linux glibc and /proc/self/fd are part of the managed VM/container baseline. Read each
// directory entry incrementally and anchor each path component to an open directory descriptor,
// so even a concurrent rename cannot redirect an open through a symlink.
const collectorSetup = `
const fs = require("node:fs");
let ptr, read, toArrayBuffer;
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const parentFlags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
const descriptor = (fd) => "/proc/self/fd/" + fd;
let libc;
try {
  const ffi = require("bun:ffi");
  const { dlopen, FFIType } = ffi;
  ({ ptr, read, toArrayBuffer } = ffi);
  libc = dlopen("libc.so.6", {
    opendir: { args: [FFIType.ptr], returns: FFIType.ptr },
    readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
    closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
    memset: { args: [FFIType.ptr, FFIType.i32, FFIType.u64], returns: FFIType.ptr },
    strlen: { args: [FFIType.ptr], returns: FFIType.u64 },
  }).symbols;
} catch {
  process.exit(86);
}
`;

/** The only probe answer that proves the collector program ran. An incompatible Bun can exit 0
 * without evaluating it (for example by printing CLI help), so the exit status alone is not proof. */
export const OUTPUT_COLLECTOR_PROBE_MARKER = "armada-output-collector-ready";

/** Armada's managed runtime Bun. Golden builds provision it at the protected path independently of
 * any repository Bun pin. */
export const OUTPUT_COLLECTOR_BUN_VERSION = "1.4.2";

export const OUTPUT_COLLECTOR_PROBE = collectorShell(
  collectorSetup +
    String.raw`
try {
  const root = fs.openSync("/", parentFlags);
  try {
    const stream = libc.opendir(ptr(Buffer.from(descriptor(root) + "\0")));
    if (!stream) process.exit(86);
    libc.closedir(stream);
  } finally {
    fs.closeSync(root);
  }
} catch {
  process.exit(86);
}
console.log(${JSON.stringify(OUTPUT_COLLECTOR_PROBE_MARKER)});
`,
);
export const OUTPUT_COLLECTOR = collectorShell(
  collectorSetup +
    String.raw`
const files = [];
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
let directory = fs.openSync("/", parentFlags);
try {
  for (const part of ${JSON.stringify(OUTPUT_DIRECTORY)}.slice(1).split("/")) {
    const next = fs.openSync(descriptor(directory) + "/" + part, parentFlags);
    fs.closeSync(directory);
    directory = next;
  }
  const base = descriptor(directory);
  const stream = libc.opendir(ptr(Buffer.from(base + "\0")));
  if (!stream) process.exit(5);
  const names = [];
  let count = 0;
  try {
    const errno = libc.__errno_location();
    while (true) {
      libc.memset(errno, 0, 4);
      const entry = libc.readdir(stream);
      if (!entry) {
        if (read.i32(errno)) process.exit(5);
        break;
      }
      // d_name is at byte 19 of Linux's 64-bit dirent (x64 and arm64).
      const start = entry + 19;
      const raw = new Uint8Array(toArrayBuffer(start, 0, Number(libc.strlen(start))));
      if (raw[0] === 46 && (raw.length === 1 || (raw.length === 2 && raw[1] === 46))) continue;
      if (++count > ${OUTPUT_MAX_ENTRIES}) process.exit(3);
      let name;
      try {
        name = decoder.decode(raw);
      } catch {
        continue;
      }
      if ((${validOutputName.toString()})(name)) names.push(name);
    }
  } finally {
    libc.closedir(stream);
  }
  let total = 0;
  let budget = 2;
  for (const name of names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (files.length === ${OUTPUT_MAX_FILES}) break;
    let fd;
    try {
      fd = fs.openSync(base + "/" + name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > ${OUTPUT_MAX_BYTES} - total) continue;
      const buffer = Buffer.alloc(${OUTPUT_MAX_BYTES + 1});
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (length > ${OUTPUT_MAX_BYTES} - total) continue;
      const item = { name, base64: buffer.subarray(0, length).toString("base64") };
      const size = Buffer.byteLength(JSON.stringify(item)) + 2;
      if (budget + size > 59000) continue;
      total += length;
      budget += size;
      files.push(item);
    } catch {
      // Entries can vanish or become unreadable while the agent is writing.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
} catch (error) {
  process.exit(error.code === "ENOENT" ? 4 : 5);
} finally {
  fs.closeSync(directory);
}
console.log(JSON.stringify(files));
`,
);

export type OutputFailureReason =
  | "collector_unsupported"
  | "output_directory_missing"
  | "output_limit"
  | "collector_failed"
  | "output_unavailable"
  | "output_timeout"
  | "output_busy"
  | "pre_stop_budget_exhausted";

export class OutputCollectionError extends Error {
  constructor(readonly reason: OutputFailureReason) {
    super(reason);
  }
}

/** Both cloud adapters interpret the same fixed collector exit codes. */
export function readCollectorResult(status: number | null, stdout: string): OutputFile[] {
  switch (status) {
    case 0:
      return parseCollectorOutput(stdout);
    case 86:
    case 126:
    case 127:
      throw new OutputCollectionError("collector_unsupported");
    case 4:
      throw new OutputCollectionError("output_directory_missing");
    case 3:
      throw new OutputCollectionError("output_limit");
    default:
      throw new OutputCollectionError("collector_failed");
  }
}

/** Interpret the capability probe: only the exact marker proves support. */
export function readCollectorProbeResult(status: number | null, stdout: string): true {
  if (status !== 0) {
    readCollectorResult(status, "");
    throw new OutputCollectionError("collector_failed");
  }
  if (stdout.trim() !== OUTPUT_COLLECTOR_PROBE_MARKER) throw new OutputCollectionError("collector_unsupported");
  return true;
}

/** Parse the fixed collector's stdout. Throws on anything the collector cannot have produced. */
export function parseCollectorOutput(stdout: string): OutputFile[] {
  if (stdout.length > 60000) throw Error("output_limit");
  return parseOutputFiles(JSON.parse(stdout));
}

/** Parse a collector's `[{name, base64}]` list (cloud collector or the agent runtime's read). */
export function parseOutputFiles(values: unknown): OutputFile[] {
  if (!Array.isArray(values)) throw Error("invalid_output");
  return values.map((value) => {
    if (
      !value ||
      !validOutputName(value.name) ||
      typeof value.base64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)
    )
      throw Error("invalid_output");
    return { name: value.name, bytes: new Uint8Array(Buffer.from(value.base64, "base64")) };
  });
}

/** Server-side admission of any provider's read: names and bounds are enforced here, not trusted. */
export function admitOutputs(files: readonly OutputFile[]): OutputFile[] {
  if (files.length > OUTPUT_MAX_FILES) throw Error("output_limit");
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (!validOutputName(file.name) || names.has(file.name) || !(file.bytes instanceof Uint8Array))
      throw Error("invalid_output");
    names.add(file.name);
    total += file.bytes.length;
    if (file.bytes.length > OUTPUT_MAX_BYTES || total > OUTPUT_MAX_BYTES) throw Error("output_limit");
  }
  return [...files];
}

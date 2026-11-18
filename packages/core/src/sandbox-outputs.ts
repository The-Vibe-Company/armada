import { SNAPSHOT_BASELINE_BUN } from "./snapshot-baseline.ts";
/** Declared sandbox outputs (#2570): one fixed directory, bounded snapshot, no caller-supplied path. */

import {
  OUTPUT_CHUNK_BYTES,
  OUTPUT_DIRECTORY,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_ENTRIES,
  OUTPUT_MAX_FILES,
  type OutputChunkRequest,
  type OutputEntry,
  validOutputChunk,
  validOutputEntry,
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

// Readers in order, each with the same bounds and exclusions:
// 1. Armada's managed Bun at the root-owned /opt/armada/runtime-bun/bun (the Modal image, and every
//    Boat golden built since #2634). This is the guaranteed path; the golden build verifies it.
// 2. Unprivileged only: a guest Bun at a fixed path that actually evaluates code. Old Bun releases
//    print their help and exit 0 without running the program, so they are skipped, never trusted.
// 3. The pre-#2634 Python reader. Boat sandboxes launched from older goldens have no managed Bun;
//    whatever collected there before this change keeps collecting after an upgrade.
// A reader that exits 86 (no FFI, no descriptor filesystem) hands over to the next one; it printed
// nothing. Only fixed paths, a fixed working directory and a cleared environment are used. In a
// privileged exec context, never fall back to an executable the agent can replace.
const READERS = `cd / || exit 5
uid=$(/usr/bin/id -u) || exit 86
protected_path() {
  armada_path=$1
  while [ -n "$armada_path" ]; do
    [ ! -L "$armada_path" ] || return 1
    metadata=$(/usr/bin/stat -c '%u %a' -- "$armada_path") || return 1
    set -- $metadata
    [ "$1" = 0 ] && [ "$((0$2 & 022))" = 0 ] || return 1
    armada_path=\${armada_path%/*}
  done
}
isolated() { /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin "$@"; }
attempt() {
  isolated "$@"
  armada_status=$?
  [ "$armada_status" = 86 ] || exit "$armada_status"
}
`;

const managedBun = (
  program: string,
) => `if [ -f /opt/armada/runtime-bun/bun ] && [ -x /opt/armada/runtime-bun/bun ] && protected_path /opt/armada/runtime-bun/bun 2>/dev/null; then
  attempt /opt/armada/runtime-bun/bun --no-env-file --no-install -e ${shellQuote(program)}
fi
`;

const collectorShell = (program: string, python: string) => `${READERS}${managedBun(program)}if [ "$uid" != 0 ]; then
  for armada_bun in /usr/local/bin/bun /usr/bin/bun /home/user/.bun/bin/bun; do
    [ -f "$armada_bun" ] && [ -x "$armada_bun" ] || continue
    [ "$(isolated "$armada_bun" --no-env-file --no-install -e 'console.log("armada-bun-evaluates")' 2>/dev/null)" = armada-bun-evaluates ] || continue
    attempt "$armada_bun" --no-env-file --no-install -e ${shellQuote(program)}
  done
fi
for armada_python in /usr/local/bin/python3 /usr/bin/python3; do
  [ -x "$armada_python" ] || continue
  if [ "$uid" = 0 ]; then
    armada_python=$(/usr/bin/readlink -f -- "$armada_python") && protected_path "$armada_python" 2>/dev/null || continue
  fi
  attempt "$armada_python" -I -c ${shellQuote(python)}
done
exit 86`;

/** The managed Bun alone: what the golden build must prove before a snapshot is taken. */
const managedShell = (program: string) => `${READERS}${managedBun(program)}exit 86`;

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
export const OUTPUT_COLLECTOR_BUN_VERSION = SNAPSHOT_BASELINE_BUN;

const probeProgram =
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
`;

/** Proves the managed Bun reader alone (the golden build's check before a snapshot is taken). */
export const OUTPUT_COLLECTOR_MANAGED_PROBE = managedShell(probeProgram);

// The pre-#2634 reader, kept for sandboxes from goldens built before the managed Bun existed.
// Same bounds, exclusions, exit codes and name rules as the Bun program (UTF-16 length like JS).
const pythonSetup = `import os,stat,json,base64,sys
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
`;
const pythonProbe = `${pythonSetup}os.close(os.open('/',flags))
print(${JSON.stringify(OUTPUT_COLLECTOR_PROBE_MARKER)})
`;
const pythonCollector = (chunk?: OutputChunkRequest | null) =>
  pythonSetup +
  String.raw`def valid(name):
 if name in ('.','..') or '/' in name or '\\' in name: return False
 if any(ord(c)<32 or ord(c)==127 for c in name): return False
 return 0<len(name.encode('utf-16-le','surrogatepass'))//2<=255
part=json.loads(${JSON.stringify(JSON.stringify(chunk === undefined ? false : chunk))})
files=[]
try:
 directory=os.open('/',flags)
 for component in ${JSON.stringify(OUTPUT_DIRECTORY)}.strip('/').split('/'):
  parent=directory
  try: directory=os.open(component,flags,dir_fd=parent)
  finally: os.close(parent)
except FileNotFoundError: sys.exit(4)
except OSError: sys.exit(5)
try:
 names=[]
 count=0
 if part:
  names=[part['entry']['name']]
 else:
  with os.scandir(directory) as entries:
   for entry in entries:
    count+=1
    if count>${OUTPUT_MAX_ENTRIES}: sys.exit(3)
    try: entry.name.encode('utf-8')
    except UnicodeEncodeError: continue
    if valid(entry.name): names.append(entry.name)
 names.sort(key=lambda name: name.encode('utf-8'))
 total=0
 budget=2
 for name in names:
  if len(files)==${OUTPUT_MAX_FILES}: break
  try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
  except OSError: continue
  try:
   info=os.fstat(fd)
   if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: continue
   if part is not False:
    def entry_for(st):
     return dict(name=name,size=min(st.st_size,9007199254740991),revision=f'{st.st_dev}:{st.st_ino}:{st.st_mtime_ns}:{st.st_ctime_ns}')
    entry=entry_for(info)
    if part is None:
     files.append(entry)
     continue
    if entry != part['entry']: continue
    length=min(part.get('length',${OUTPUT_CHUNK_BYTES}),entry['size']-part['offset'])
    data=os.pread(fd,length,part['offset'])
    after=os.fstat(fd)
    if len(data)==length and after.st_nlink==1 and entry_for(after)==entry: files.append({'name':name,'base64':base64.b64encode(data).decode()})
    continue
   if info.st_size>${OUTPUT_MAX_BYTES}-total: continue
   data=os.read(fd,${OUTPUT_MAX_BYTES + 1})
   if len(data)>${OUTPUT_MAX_BYTES}-total: continue
   item={'name':name,'base64':base64.b64encode(data).decode()}
   size=len(json.dumps(item,separators=(',',':')))+2
   if budget+size>59000: continue
   total+=len(data)
   budget+=size
   files.append(item)
  except OSError: continue
  finally: os.close(fd)
except OSError: sys.exit(5)
finally: os.close(directory)
print(json.dumps(files,separators=(',',':')))
`;

export const OUTPUT_COLLECTOR_PROBE = collectorShell(probeProgram, pythonProbe);
function outputCollector(chunk?: OutputChunkRequest | null): string {
  return collectorShell(
    collectorSetup +
      String.raw`
const files = [];
const part = ${JSON.stringify(chunk === undefined ? false : chunk)};
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
let directory = fs.openSync("/", parentFlags);
try {
  for (const part of ${JSON.stringify(OUTPUT_DIRECTORY)}.slice(1).split("/")) {
    const next = fs.openSync(descriptor(directory) + "/" + part, parentFlags);
    fs.closeSync(directory);
    directory = next;
  }
  const base = descriptor(directory);
  const names = [];
  if (part) names.push(part.entry.name);
  else {
    const stream = libc.opendir(ptr(Buffer.from(base + "\0")));
    if (!stream) process.exit(5);
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
  }
  let total = 0;
  let budget = 2;
  for (const name of names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (files.length === ${OUTPUT_MAX_FILES}) break;
    let fd;
    try {
      fd = fs.openSync(base + "/" + name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1) continue;
      if (part !== false) {
        const entryFor = () => {
          const st = fs.fstatSync(fd, { bigint: true });
          if (!st.isFile() || st.nlink !== 1n) throw Error("invalid_output");
          return { name, size: Math.min(Number(st.size), Number.MAX_SAFE_INTEGER), revision: [st.dev, st.ino, st.mtimeNs, st.ctimeNs].join(":") };
        };
        const entry = entryFor();
        if (part === null) {
          files.push(entry);
          continue;
        }
        if (entry.size !== part.entry.size || entry.revision !== part.entry.revision) continue;
        const buffer = Buffer.alloc(Math.min(part.length ?? ${OUTPUT_CHUNK_BYTES}, entry.size - part.offset));
        const length = fs.readSync(fd, buffer, 0, buffer.length, part.offset);
        if (length === buffer.length && entryFor().revision === entry.revision)
          files.push({ name, base64: buffer.toString("base64") });
        continue;
      }
      if (info.size > ${OUTPUT_MAX_BYTES} - total) continue;
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
    pythonCollector(chunk),
  );
}

export const OUTPUT_COLLECTOR = outputCollector();

export function outputEntryCollector(chunk: OutputChunkRequest | null): string {
  if (chunk !== null && !validOutputChunk(chunk)) throw Error("invalid_output_chunk");
  return outputCollector(
    chunk === null
      ? null
      : {
          entry: { name: chunk.entry.name, size: chunk.entry.size, revision: chunk.entry.revision },
          offset: chunk.offset,
          ...(chunk.length !== undefined ? { length: chunk.length } : {}),
        },
  );
}

export function parseOutputEntries(values: unknown): OutputEntry[] {
  if (!Array.isArray(values) || values.length > OUTPUT_MAX_FILES || !values.every(validOutputEntry))
    throw Error("invalid_output");
  if (new Set(values.map(({ name }) => name)).size !== values.length) throw Error("invalid_output");
  return values.map(({ name, size, revision }) => ({ name, size, revision }));
}

export function parseOutputChunk(values: unknown, chunk: OutputChunkRequest): Uint8Array | null {
  if (Array.isArray(values) && values.length === 0) return null;
  const length = Math.min(chunk.length ?? OUTPUT_CHUNK_BYTES, chunk.entry.size - chunk.offset);
  if (
    !Array.isArray(values) ||
    values.length !== 1 ||
    typeof values[0]?.base64 !== "string" ||
    values[0].base64.length > Math.ceil(length / 3) * 4
  )
    throw Error("invalid_output");
  const [file] = parseOutputFiles(values);
  if (!file || file.name !== chunk.entry.name || file.bytes.length !== length) throw Error("invalid_output");
  return file.bytes;
}

export function readCollectorEntries(status: number | null, stdout: string): OutputEntry[] {
  if (status !== 0) readCollectorResult(status, stdout);
  if (stdout.length > 60000) throw Error("output_limit");
  return parseOutputEntries(JSON.parse(stdout));
}

export function readCollectorChunk(
  status: number | null,
  stdout: string,
  chunk: OutputChunkRequest,
): Uint8Array | null {
  if (status !== 0) readCollectorResult(status, stdout);
  if (stdout.length > Math.ceil((chunk.length ?? OUTPUT_CHUNK_BYTES) / 3) * 4 + 4096) throw Error("output_limit");
  return parseOutputChunk(JSON.parse(stdout), chunk);
}

export type OutputFailureReason =
  | "collector_unsupported"
  | "output_directory_missing"
  | "output_limit"
  | "collector_failed"
  | "output_protocol_unsupported"
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

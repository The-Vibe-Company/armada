/** Declared sandbox outputs (#2570): one fixed directory, bounded snapshot, no caller-supplied path. */
import { OUTPUT_MAX_BYTES, OUTPUT_MAX_ENTRIES, OUTPUT_MAX_FILES, validOutputName } from "./sandbox-output-limits.ts";

export {
  DOCKER_OUTPUT_DIRECTORY,
  OUTPUT_DIRECTORY,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_ENTRIES,
  OUTPUT_MAX_FILES,
  outputDirectory,
} from "./sandbox-output-limits.ts";

/** One declared output file as read by a provider. Callers still validate with `admitOutputs`. */
export interface OutputFile {
  name: string;
  bytes: Uint8Array;
}

// No caller-controlled command, root, traversal, symlink following or special files. Every entry is
// inspected before any limit applies: the count and byte bounds count admitted files only, in name
// order, so excluded entries (subdirectories, links, oversized files) never hide a deliverable.
export const OUTPUT_COLLECTOR = `python3 - <<'PY'
import os,stat,json,base64,sys
files=[]
try:
 root=os.open('/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try: directory=os.open('outputs',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)
 finally: os.close(root)
except FileNotFoundError: directory=None
if directory is not None:
 try:
  names=[]
  for index,entry in enumerate(os.scandir(directory)):
   if index>=${OUTPUT_MAX_ENTRIES}: sys.exit(3)
   name=entry.name
   # Skip names the server would refuse so one bad entry never freezes the snapshot.
   if len(name)>255 or '\\\\' in name or any(ord(c)<32 or ord(c)==127 for c in name): continue
   try: name.encode('utf-8')
   except UnicodeEncodeError: continue
   names.append(name)
  names.sort()
  total=0
  budget=2
  for name in names:
   if len(files)==${OUTPUT_MAX_FILES}: break
   try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
   except OSError: continue
   try:
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>${OUTPUT_MAX_BYTES}-total: continue
    data=os.read(fd,${OUTPUT_MAX_BYTES + 1})
    if len(data)>${OUTPUT_MAX_BYTES}-total: continue
    item={'name':name,'base64':base64.b64encode(data).decode()}
    size=len(json.dumps(item))+2
    # Escaped names count toward the transport budget like bytes: skipped, never truncated output.
    if budget+size>59000: continue
    total+=len(data)
    budget+=size
    files.append(item)
   except OSError: continue
   finally: os.close(fd)
 finally: os.close(directory)
print(json.dumps(files))
PY`;

/** Parse the fixed collector's stdout. Throws on anything the collector cannot have produced. */
export function parseCollectorOutput(stdout: string): OutputFile[] {
  if (stdout.length > 60000) throw Error("output_limit");
  return parseOutputFiles(JSON.parse(stdout));
}

/** Parse a collector's `[{name, base64}]` list (Python collector or the agent runtime's read). */
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

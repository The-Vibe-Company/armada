/** Declared sandbox outputs (#2570): one fixed directory, bounded snapshot, no caller-supplied path. */
export const OUTPUT_DIRECTORY = "/workspace/outputs";
export const OUTPUT_MAX_FILES = 32;
export const OUTPUT_MAX_BYTES = 32768;

/** One declared output file as read by a provider. Callers still validate with `admitOutputs`. */
export interface OutputFile {
  name: string;
  bytes: Uint8Array;
}

// No caller-controlled command, root, traversal, symlink following or special files.
export const OUTPUT_COLLECTOR = `python3 - <<'PY'
import os,stat,json,base64,itertools
files=[]
total=0
try:
 root=os.open('/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 directory=os.open('outputs',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)
 try:
  for entry in itertools.islice(os.scandir(directory),32):
   name=entry.name
   if len(name)>255 or '/' in name or '\\\\' in name: continue
   # Skip names the server would refuse so one bad entry never freezes the snapshot.
   if any(ord(c)<32 or ord(c)==127 for c in name): continue
   try: name.encode('utf-8')
   except UnicodeEncodeError: continue
   try:
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
    try:
     info=os.fstat(fd)
     if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>32768: continue
     data=os.read(fd,32769)
     if len(data)>32768 or total+len(data)>32768: continue
     total+=len(data)
     files.append({'name':name,'base64':base64.b64encode(data).decode()})
    finally: os.close(fd)
   except OSError: continue
 finally: os.close(directory); os.close(root)
except FileNotFoundError: pass
while len(json.dumps(files))>59000: files.pop()
print(json.dumps(files))
PY`;

function validName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[^/\\]{1,255}$/.test(name) &&
    ![...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    name !== "." &&
    name !== ".."
  );
}

/** Parse the fixed collector's stdout. Throws on anything the collector cannot have produced. */
export function parseCollectorOutput(stdout: string): OutputFile[] {
  if (stdout.length > 60000) throw Error("output_limit");
  const values: unknown = JSON.parse(stdout);
  if (!Array.isArray(values)) throw Error("invalid_output");
  return values.map((value) => {
    if (
      !value ||
      !validName(value.name) ||
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
    if (!validName(file.name) || names.has(file.name) || !(file.bytes instanceof Uint8Array))
      throw Error("invalid_output");
    names.add(file.name);
    total += file.bytes.length;
    if (file.bytes.length > OUTPUT_MAX_BYTES || total > OUTPUT_MAX_BYTES) throw Error("output_limit");
  }
  return [...files];
}

/** Select declared outputs from a retained-disk listing (paths relative to the disk root).
 * Only direct regular-file children of the declared directory, in name order, within bounds.
 * Returns the snapshot paths to fetch. A truncated listing still yields the outputs it lists. */
export function selectRetainedOutputs(
  entries: readonly { path: string; kind: string; size?: number | null }[],
): { name: string; path: string; size: number }[] {
  const prefix = `${OUTPUT_DIRECTORY.slice(1)}/`;
  const selected: { name: string; path: string; size: number }[] = [];
  for (const entry of entries) {
    const relative = entry.path.replace(/^\/+/, "");
    if (!relative.startsWith(prefix)) continue;
    const name = relative.slice(prefix.length);
    if (entry.kind !== "file" || !validName(name)) continue;
    const size = entry.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > OUTPUT_MAX_BYTES) continue;
    selected.push({ name, path: entry.path, size });
  }
  selected.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const admitted: typeof selected = [];
  let total = 0;
  for (const entry of selected) {
    if (admitted.length === OUTPUT_MAX_FILES) break;
    if (total + entry.size > OUTPUT_MAX_BYTES) continue;
    total += entry.size;
    admitted.push(entry);
  }
  return admitted;
}

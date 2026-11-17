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
 * Returns the snapshot paths to fetch. Only for a complete listing: a truncated one may omit outputs. */
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
  return bounded(selected);
}

/** One entry per name (the last wins, as in an archive), in name order, within count and byte bounds. */
function bounded<T extends { name: string; size: number }>(entries: readonly T[]): T[] {
  const unique = [...new Map(entries.map((entry) => [entry.name, entry])).values()];
  unique.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const admitted: T[] = [];
  let total = 0;
  for (const entry of unique) {
    if (admitted.length === OUTPUT_MAX_FILES) break;
    if (total + entry.size > OUTPUT_MAX_BYTES) continue;
    total += entry.size;
    admitted.push(entry);
  }
  return admitted;
}

/** Bound on a retained declared-directory archive (whole subtree, including skipped files). */
export const OUTPUT_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;

/** A tar text field; null when not valid UTF-8 (the live collector skips such names too). */
function tarText(bytes: Uint8Array): string | null {
  const end = bytes.indexOf(0);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(end === -1 ? bytes : bytes.subarray(0, end));
  } catch {
    return null;
  }
}

function tarSize(block: Uint8Array): number {
  // Base-256 sizes (> 8 GiB) cannot belong to a bounded archive.
  if ((block[124] ?? 0) & 0x80) throw Error("invalid_archive");
  const text = tarText(block.subarray(124, 136))?.trim();
  if (text === undefined || !/^[0-7]*$/.test(text)) throw Error("invalid_archive");
  return text ? Number.parseInt(text, 8) : 0;
}

// Header-only entries that describe the next entry or the archive, never a file.
const TAR_METADATA = new Set(["K", "g", "V"]);

/** Declared outputs from a tar of the declared directory's subtree (a retained-disk folder read).
 * Complete coverage of the directory: only direct regular-file children, in name order, within the
 * same bounds as `selectRetainedOutputs`. Subdirectories, links, special entries and names that are
 * not UTF-8 are skipped. The archive must identify its root by the directory's own entry, either
 * relative to the directory (`./`) or to the disk root (`workspace/outputs/`). Any other layout,
 * or an entry outside that root, throws: a guessed root could publish a subdirectory's files or
 * read as an empty directory and delete the previous snapshot. */
export function parseOutputArchive(archive: Uint8Array): OutputFile[] {
  const entries: { path: string | null; regular: boolean; bytes: Uint8Array }[] = [];
  let offset = 0;
  let longName: string | null | undefined;
  let paxPath: string | null | undefined;
  for (;;) {
    if (offset + 512 > archive.length) throw Error("invalid_archive");
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = tarSize(header);
    const dataStart = offset + 512;
    if (dataStart + size > archive.length) throw Error("invalid_archive");
    const data = archive.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === "L") {
      longName = tarText(data);
      continue;
    }
    if (type === "x") {
      // Only the path record matters; other records (xattrs) may be binary.
      const text = Buffer.from(data).toString("latin1");
      for (const match of text.matchAll(/(?:^|\n)\d+ path=([^\n]*)/g))
        paxPath = tarText(new Uint8Array(Buffer.from(match[1] ?? "", "latin1")));
      continue;
    }
    if (TAR_METADATA.has(type)) continue;
    const magic = tarText(header.subarray(257, 263));
    const prefix = magic?.startsWith("ustar") ? tarText(header.subarray(345, 500)) : "";
    const name = tarText(header.subarray(0, 100));
    const path =
      paxPath !== undefined
        ? paxPath
        : longName !== undefined
          ? longName
          : prefix === null || name === null
            ? null
            : prefix
              ? `${prefix}/${name}`
              : name;
    longName = undefined;
    paxPath = undefined;
    const normalized = path === null ? null : path.replace(/^(?:\.\/|\/)+/, "").replace(/\/+$/, "");
    entries.push({
      path: normalized === "." ? "" : normalized,
      regular: type === "0" || type === "\0",
      bytes: data,
    });
  }
  const declared = OUTPUT_DIRECTORY.slice(1);
  let root: string;
  if (entries.length === 0 || entries.some((entry) => entry.path === "")) root = "";
  else if (
    entries.some((entry) => entry.path === declared && !entry.regular) &&
    entries.every(
      (entry) =>
        entry.path === null ||
        entry.path === declared ||
        entry.path.startsWith(`${declared}/`) ||
        declared.startsWith(`${entry.path}/`),
    )
  )
    root = `${declared}/`;
  else throw Error("invalid_archive");
  const selected: { name: string; path: string; size: number; bytes: Uint8Array }[] = [];
  for (const entry of entries) {
    if (!entry.regular || entry.path === null || !entry.path.startsWith(root)) continue;
    const name = entry.path.slice(root.length);
    if (!validName(name) || entry.bytes.length > OUTPUT_MAX_BYTES) continue;
    selected.push({ name, path: entry.path, size: entry.bytes.length, bytes: entry.bytes });
  }
  return bounded(selected).map((entry) => ({ name: entry.name, bytes: new Uint8Array(entry.bytes) }));
}

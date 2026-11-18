/** Declared sandbox outputs (#2570): one fixed directory and bounds shared by the collectors. */
export const OUTPUT_DIRECTORY = "/home/user/outputs";
export const OUTPUT_MAX_FILES = 32;
export const OUTPUT_MAX_BYTES = 32768;
/** Directory entries a collector inspects. A larger directory is unreadable now (the previous
 * snapshot stays), never a partial read that would drop unseen files. */
export const OUTPUT_MAX_ENTRIES = 4096;

/** Names every collector skips and the server refuses: no separators, control characters or dot entries. */
export function validOutputName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[^/\\]{1,255}$/.test(name) &&
    ![...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    name !== "." &&
    name !== ".."
  );
}

export const OUTPUT_CHUNK_BYTES = OUTPUT_MAX_BYTES;
export const OUTPUT_MAX_READ_BYTES = 512 * 1024;
export const OUTPUT_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const OUTPUT_MAX_SANDBOX_BYTES = 64 * 1024 * 1024;
export const OUTPUT_MAX_ORG_BYTES = 1024 * 1024 * 1024;

export interface OutputEntry {
  name: string;
  size: number;
  revision: string;
}

export interface OutputChunkRequest {
  entry: OutputEntry;
  offset: number;
  length?: number;
}

export function validOutputEntry(entry: unknown): entry is OutputEntry {
  if (!entry || typeof entry !== "object") return false;
  const { name, size, revision } = entry as OutputEntry;
  return (
    validOutputName(name) &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    typeof revision === "string" &&
    /^-?\d{1,24}(?::-?\d{1,24}){3}$/.test(revision)
  );
}

export function validOutputChunk(chunk: unknown): chunk is OutputChunkRequest {
  if (!chunk || typeof chunk !== "object") return false;
  const { entry, offset, length = OUTPUT_CHUNK_BYTES } = chunk as OutputChunkRequest;
  return (
    validOutputEntry(entry) &&
    entry.size <= OUTPUT_MAX_FILE_BYTES &&
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    offset < entry.size &&
    offset % OUTPUT_CHUNK_BYTES === 0 &&
    Number.isSafeInteger(length) &&
    length >= OUTPUT_CHUNK_BYTES &&
    length <= OUTPUT_MAX_READ_BYTES &&
    length % OUTPUT_CHUNK_BYTES === 0
  );
}
